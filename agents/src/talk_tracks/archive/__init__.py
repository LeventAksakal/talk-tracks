"""The track archive: every room's tracks on disk, served for rewind, copied to a bucket, read back on restart.

``store`` writes the format of ``wiki/howto/archive.md``, ``mp4`` its media segments, ``restore`` reads the newest
snapshot of an agent, ``bucket`` copies finished files off the VM, and ``relay`` follows the rooms over MoQ.
Run it with ``python -m talk_tracks.archive``.
"""
