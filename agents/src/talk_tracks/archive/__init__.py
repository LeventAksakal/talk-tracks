"""The track archive: every room's tracks on disk, served for rewind, copied to a bucket (``wiki/howto/archive.md``).

``slices`` is the library agents record their own tracks with and answer FETCH from (decision 0012). The rest is the
room service, run with ``python -m talk_tracks.archive``: ``store`` sets the room clock and writes the speaker's media
(``mp4``, ``hls``) and slides in room time, ``catalog`` builds ``talk/<room>/catalog``, ``relay`` follows the rooms
over MoQ, ``bucket`` copies finished files off the VM.
"""
