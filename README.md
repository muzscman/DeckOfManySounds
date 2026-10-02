# The Deck of Many Sounds

A local 16-pad soundboard for Spotify desktop playback and overlapping local sound effects.

## Start

Run `./start.sh` from this folder, then open <http://127.0.0.1:8765> in your browser. Leave the terminal running while using the page.

The 4 × 4 deck is the main control surface. Add Spotify links or local audio files below it; each new item fills the next empty pad. Press a filled pad to play it, or use its edit button to change the source, label, and local sound looping. A looping pad stops when pressed again. Each local clip has its own saved volume slider in the Sound clips section; changes also affect copies already playing, whether started there or from a deck pad. Spotify pads switch the music source, while local sound pads can overlap it. The top deck controls pause Spotify music or stop all local sounds.

Spotify controls use the Linux desktop app's MPRIS interface. Open the Spotify app, or use a saved link to launch it. The page also has play/pause, previous, and next controls. Spotify must be signed in and connected to the internet to stream. Some Spotify client versions may open a playlist without starting audio; use the play button if that happens.

Deck Spotify pads require the desktop app to be running. On KDE, a short lived KWin script restores focus to the soundboard if Spotify raises its window while opening a playlist. The script unloads after two seconds. The Spotify library's Play button can still launch the app when it is closed.

Links, pad assignments, and imported audio files are saved in this folder's `data/` directory, so they remain after you close the browser or stop the server. Keep this directory when moving or backing up the soundboard. Existing items in the browser's storage are imported automatically when that browser next opens the updated app. Clicking a clip multiple times plays overlapping copies. Local clips also play over Spotify. Audio files are limited to 100 MB each.

The server listens only on `127.0.0.1:8765` and accepts commands only from its own page. It requires Python 3 and the system `python3-gi` package. If Spotify is installed through a format that does not expose an MPRIS session player, the page will show it as disconnected.
