@echo off
REM ============================================
REM Sakanify - One-Click Commit & Push
REM Double-click this file whenever Claude Desktop
REM says the code is ready. No typing required.
REM ============================================

cd /d T:\sakanify

echo Checking for a stale git lock file...
if exist ".git\index.lock" (
    echo Found .git\index.lock - removing it...
    del /f ".git\index.lock" 2>nul
    if exist ".git\index.lock" (
        echo.
        echo Could not remove the lock file automatically.
        echo Please close VS Code / GitHub Desktop / any other
        echo program that has T:\sakanify open, then run this
        echo script again.
        echo.
        pause
        exit /b 1
    )
    echo Lock file removed successfully.
)

echo.
echo Staging changes...
git add .

git diff --cached --quiet
if %errorlevel%==0 (
    echo.
    echo Nothing new to commit. Exiting.
    pause
    exit /b 0
)

echo.
set /p msg="Commit message (press Enter to auto-generate one): "
if "%msg%"=="" (
    set msg=Update %date% %time%
)

echo.
echo Committing...
git commit -m "%msg%"

echo.
echo Pushing to GitHub...
git push origin main

echo.
echo ============================================
echo Done. Go check the Actions tab on GitHub for
echo the real CI result before treating this as verified.
echo ============================================
echo.
pause
