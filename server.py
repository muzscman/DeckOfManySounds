#!/usr/bin/env python3
"""Local-only soundboard server and Spotify MPRIS bridge."""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

try:
    from gi.repository import Gio, GLib
except ImportError:
    print('Python GObject bindings are required (usually python3-gi).', file=sys.stderr)
    sys.exit(1)


ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('SOUNDBOARD_DATA_DIR', ROOT / 'data'))
CLIP_DIR = DATA / 'clips'
LIBRARY_FILE = DATA / 'library.json'
LIBRARY_LOCK = threading.RLock()
PORT = 8765
OBJECT = '/org/mpris/MediaPlayer2'
PLAYER = 'org.mpris.MediaPlayer2.Player'
PROPERTIES = 'org.freedesktop.DBus.Properties'
URI_PATTERN = re.compile(r'^spotify:(track|playlist):[A-Za-z0-9]{22}$')
COMMANDS = {'playpause': 'PlayPause', 'pause': 'Pause', 'next': 'Next', 'previous': 'Previous'}
SCRIPTING = 'org.kde.kwin.Scripting'
CLIP_ID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
MAX_AUDIO = 100 * 1024 * 1024


def empty_library():
    return {'spotify': [], 'deck': [None] * 16, 'clips': []}


def load_library():
    if not LIBRARY_FILE.exists():
        return empty_library()
    return json.loads(LIBRARY_FILE.read_text(encoding='utf-8'))


def save_library(library):
    DATA.mkdir(parents=True, exist_ok=True)
    temporary = DATA / f'.library-{uuid.uuid4().hex}.tmp'
    try:
        with temporary.open('w', encoding='utf-8') as output:
            json.dump(library, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(LIBRARY_FILE)
    finally:
        temporary.unlink(missing_ok=True)


def validate_library_update(payload, current):
    links = payload.get('spotify')
    deck = payload.get('deck')
    clip_volumes = payload.get('clipVolumes')
    if not isinstance(links, list) or not isinstance(deck, list) or len(deck) != 16:
        raise ValueError('Invalid soundboard library.')
    seen = set()
    clean_links = []
    for item in links:
        if not isinstance(item, dict) or not isinstance(item.get('uri'), str) or not URI_PATTERN.fullmatch(item['uri']) or not isinstance(item.get('name'), str) or not 0 < len(item['name']) <= 80 or item['uri'] in seen:
            raise ValueError('Invalid Spotify link.')
        seen.add(item['uri'])
        clean_links.append({'uri': item['uri'], 'name': item['name']})
    clip_ids = {clip['id'] for clip in current['clips']}
    if clip_volumes is not None:
        if not isinstance(clip_volumes, dict) or not set(clip_volumes).issubset(clip_ids) or any(type(volume) is not int or not 0 <= volume <= 100 for volume in clip_volumes.values()):
            raise ValueError('Invalid clip volumes.')
    clean_deck = []
    for pad in deck:
        if pad is None:
            clean_deck.append(None)
            continue
        if not isinstance(pad, dict) or pad.get('type') not in ('spotify', 'clip') or not isinstance(pad.get('ref'), str) or not isinstance(pad.get('label'), str) or len(pad['label']) > 40:
            raise ValueError('Invalid deck pad.')
        if pad['ref'] not in (seen if pad['type'] == 'spotify' else clip_ids):
            raise ValueError('A deck pad refers to a missing sound.')
        clean_deck.append({'type': pad['type'], 'ref': pad['ref'], 'label': pad['label'], 'loop': pad['type'] == 'clip' and pad.get('loop') is True})
    clips = [dict(clip, volume=clip_volumes.get(clip['id'], clip.get('volume', 100))) for clip in current['clips']] if clip_volumes is not None else current['clips']
    return {'spotify': clean_links, 'deck': clean_deck, 'clips': clips}


def protect_soundboard_focus(connection):
    """Temporarily restore the current KWin window if Spotify activates itself."""
    if 'KDE' not in os.environ.get('XDG_CURRENT_DESKTOP', '').upper():
        return None
    name = f'soundboard-focus-{uuid.uuid4().hex}'
    loaded = False
    try:
        result = connection.call_sync(
            'org.kde.KWin', '/Scripting', SCRIPTING, 'loadScript',
            GLib.Variant('(ss)', (str(ROOT / 'focus_guard.js'), name)),
            GLib.VariantType('(i)'), Gio.DBusCallFlags.NO_AUTO_START, 1000, None,
        )
        script_id = result.unpack()[0]
        loaded = True
        connection.call_sync(
            'org.kde.KWin', f'/Scripting/Script{script_id}',
            'org.kde.kwin.Script', 'run', None, None,
            Gio.DBusCallFlags.NO_AUTO_START, 1000, None,
        )
        return name
    except GLib.Error:
        if loaded:
            release_focus_guard(name)
        return None


def release_focus_guard(name):
    if not name:
        return
    try:
        bus().call_sync(
            'org.kde.KWin', '/Scripting', SCRIPTING, 'unloadScript',
            GLib.Variant('(s)', (name,)), GLib.VariantType('(b)'),
            Gio.DBusCallFlags.NO_AUTO_START, 1000, None,
        )
    except (GLib.Error, RuntimeError):
        pass


def bus():
    try:
        return Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as error:
        raise RuntimeError(f'Could not connect to the desktop session: {error.message}') from error


def spotify_service(connection):
    result = connection.call_sync(
        'org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'ListNames', None,
        GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, 1500, None,
    )
    names = result.unpack()[0]
    candidates = [name for name in names if name.startswith('org.mpris.MediaPlayer2.') and 'spotify' in name.lower()]
    return 'org.mpris.MediaPlayer2.spotify' if 'org.mpris.MediaPlayer2.spotify' in candidates else (candidates[0] if candidates else None)


def call_player(connection, service, method, args=None):
    try:
        return connection.call_sync(
            service, OBJECT, PLAYER, method, args,
            None, Gio.DBusCallFlags.NONE, 3000, None,
        )
    except GLib.Error as error:
        raise RuntimeError(f'Spotify could not complete that command: {error.message}') from error


def player_property(connection, service, name):
    result = connection.call_sync(
        service, OBJECT, PROPERTIES, 'Get',
        GLib.Variant('(ss)', (PLAYER, name)),
        GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, 1500, None,
    )
    return result.unpack()[0]


def spotify_status():
    connection = bus()
    service = spotify_service(connection)
    if not service:
        return {'connected': False, 'playing': False, 'title': '', 'artist': ''}
    try:
        playing = player_property(connection, service, 'PlaybackStatus') == 'Playing'
        metadata = player_property(connection, service, 'Metadata')
        title = metadata.get('xesam:title', '')
        artists = metadata.get('xesam:artist', [])
        artist = ', '.join(artists) if isinstance(artists, (list, tuple)) else str(artists)
        return {'connected': True, 'playing': playing, 'title': str(title), 'artist': artist}
    except GLib.Error:
        return {'connected': True, 'playing': False, 'title': '', 'artist': ''}


def spotify_open(uri, background=False):
    if not isinstance(uri, str) or not URI_PATTERN.fullmatch(uri):
        raise ValueError('Invalid Spotify track or playlist URI.')
    connection = bus()
    service = spotify_service(connection)
    if service:
        guard = protect_soundboard_focus(connection) if background else None
        if background and 'KDE' in os.environ.get('XDG_CURRENT_DESKTOP', '').upper() and not guard:
            raise RuntimeError('Could not protect the soundboard window. Spotify was not started.')
        try:
            call_player(connection, service, 'OpenUri', GLib.Variant('(s)', (uri,)))
        except Exception:
            release_focus_guard(guard)
            raise
        if guard:
            timer = threading.Timer(2.0, release_focus_guard, args=(guard,))
            timer.daemon = True
            timer.start()
        return {'ok': True, 'launched': False}
    if background:
        raise RuntimeError('Open the Spotify desktop app first. Deck pads keep it in the background.')
    try:
        subprocess.Popen(['xdg-open', uri], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError as error:
        raise RuntimeError(f'Could not launch Spotify: {error}') from error
    return {'ok': True, 'launched': True}


def spotify_control(command):
    method = COMMANDS.get(command)
    if not method:
        raise ValueError('Unknown Spotify command.')
    connection = bus()
    service = spotify_service(connection)
    if not service:
        raise RuntimeError('Spotify is not running. Open the desktop app or play a saved link first.')
    call_player(connection, service, method)
    return {'ok': True}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        body = json.dumps(value).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/api/library':
            try:
                with LIBRARY_LOCK:
                    self.send_json(200, load_library())
            except (OSError, ValueError) as error:
                self.send_json(500, {'error': f'Could not read saved soundboard: {error}'})
            return
        if path.startswith('/api/clips/'):
            clip_id = path.removeprefix('/api/clips/')
            if not CLIP_ID.fullmatch(clip_id):
                self.send_error(404)
                return
            with LIBRARY_LOCK:
                library = load_library()
                clip = next((item for item in library['clips'] if item['id'] == clip_id), None)
            if not clip:
                self.send_error(404)
                return
            try:
                audio = (CLIP_DIR / clip_id).open('rb')
            except OSError:
                self.send_error(404)
                return
            with audio:
                self.send_response(200)
                self.send_header('Content-Type', clip['mime'])
                self.send_header('Content-Length', str(clip['size']))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                shutil.copyfileobj(audio, self.wfile, 1024 * 1024)
            return
        if path == '/api/spotify/status':
            try:
                self.send_json(200, spotify_status())
            except (RuntimeError, GLib.Error) as error:
                self.send_json(503, {'error': str(error)})
            return
        files = {'/': ('index.html', 'text/html; charset=utf-8'),
                 '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                 '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
                 '/desktop.css': ('desktop.css', 'text/css; charset=utf-8')}
        if path not in files:
            self.send_error(404)
            return
        name, mime = files[path]
        body = (ROOT / name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        origin = self.headers.get('Origin')
        if origin not in (f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'):
            self.send_json(403, {'error': 'Request must come from the local soundboard page.'})
            return
        path = urlsplit(self.path).path
        if path.startswith('/api/clips/upload/'):
            self.upload_clip(path.removeprefix('/api/clips/upload/'))
            return
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send_json(415, {'error': 'Expected JSON.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                raise ValueError('Invalid request size.')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('Invalid request.')
            if path == '/api/library':
                with LIBRARY_LOCK:
                    library = validate_library_update(payload, load_library())
                    save_library(library)
                result = library
            elif path == '/api/clips/delete':
                clip_id = payload.get('id')
                if not isinstance(clip_id, str) or not CLIP_ID.fullmatch(clip_id):
                    raise ValueError('Invalid clip ID.')
                with LIBRARY_LOCK:
                    library = load_library()
                    library['clips'] = [clip for clip in library['clips'] if clip['id'] != clip_id]
                    library['deck'] = [None if pad and pad['type'] == 'clip' and pad['ref'] == clip_id else pad for pad in library['deck']]
                    save_library(library)
                    (CLIP_DIR / clip_id).unlink(missing_ok=True)
                result = library
            elif path == '/api/spotify/open':
                result = spotify_open(payload.get('uri'), payload.get('background', True) is True)
            elif path == '/api/spotify/control':
                result = spotify_control(payload.get('command'))
            else:
                self.send_json(404, {'error': 'Unknown command.'})
                return
            self.send_json(200, result)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {'error': str(error)})
        except (RuntimeError, GLib.Error) as error:
            self.send_json(503, {'error': str(error)})
        except OSError as error:
            self.send_json(500, {'error': f'Could not save soundboard: {error}'})

    def upload_clip(self, clip_id):
        if not CLIP_ID.fullmatch(clip_id):
            self.send_json(400, {'error': 'Invalid clip ID.'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            name = unquote(self.headers.get('X-Clip-Name', ''))
            mime = self.headers.get('Content-Type', '')
            created = int(self.headers.get('X-Clip-Created', '0'))
            if not 0 < length <= MAX_AUDIO or not 0 < len(name) <= 80 or any(ord(char) < 32 for char in name) or not (mime.startswith('audio/') or mime == 'application/octet-stream') or created <= 0:
                raise ValueError('Invalid audio file or file is larger than 100 MB.')
            with LIBRARY_LOCK:
                library = load_library()
                existing = next((clip for clip in library['clips'] if clip['id'] == clip_id), None)
                if existing:
                    self.send_json(200, existing)
                    return
                CLIP_DIR.mkdir(parents=True, exist_ok=True)
                temporary = CLIP_DIR / f'.{clip_id}.tmp'
                try:
                    with temporary.open('wb') as output:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(1024 * 1024, remaining))
                            if not chunk:
                                raise ValueError('Incomplete audio upload.')
                            output.write(chunk)
                            remaining -= len(chunk)
                        output.flush()
                        os.fsync(output.fileno())
                    temporary.replace(CLIP_DIR / clip_id)
                    clip = {'id': clip_id, 'name': name, 'mime': mime, 'size': length, 'created': created, 'volume': 100}
                    library['clips'].append(clip)
                    if None in library['deck']:
                        library['deck'][library['deck'].index(None)] = {'type': 'clip', 'ref': clip_id, 'label': name[:40], 'loop': False}
                    save_library(library)
                finally:
                    temporary.unlink(missing_ok=True)
            self.send_json(200, clip)
        except (ValueError, TypeError) as error:
            self.send_json(400, {'error': str(error)})
        except OSError as error:
            self.send_json(500, {'error': f'Could not save audio file: {error}'})


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'Soundboard is running at http://127.0.0.1:{PORT}', flush=True)
    print('Press Ctrl+C to stop it.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
