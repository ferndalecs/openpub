"""Import this first in a tool that starts other programs: on Windows they start without a console
window of their own, so a tool run in the background doesn't flash windows on the screen.
"""
import subprocess
import sys

if sys.platform == 'win32' and not getattr(subprocess, '_openpub_quiet', False):
    _init = subprocess.Popen.__init__

    def _quiet_init(self, *args, **kwargs):
        kwargs['creationflags'] = kwargs.get('creationflags', 0) | subprocess.CREATE_NO_WINDOW
        _init(self, *args, **kwargs)

    subprocess.Popen.__init__ = _quiet_init
    subprocess._openpub_quiet = True
