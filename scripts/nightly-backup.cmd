@echo off
REM Nightly backup of the pilot instance.
REM
REM Called by the Windows scheduled task "Mobility Pro Freight nightly backup".
REM It runs inside the container, so it backs up the volume the application
REM actually uses rather than anything left on the host.
REM
REM Run it by hand to test:  scripts\nightly-backup.cmd
cd /d "%~dp0.."
set LOG=%~dp0..\data\backup.log
echo [%date% %time%] backup starting>>"%LOG%"
docker compose exec -T app node scripts/backup.mjs>>"%LOG%" 2>&1
echo [%date% %time%] finished with exit code %errorlevel%>>"%LOG%"
