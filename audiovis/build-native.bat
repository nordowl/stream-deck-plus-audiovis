@echo off
echo Finding Visual Studio...

for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath`) do set "VS_PATH=%%i"

if not defined VS_PATH (
    echo ERROR: Visual Studio not found.
    pause
    exit /b 1
)

echo Found VS at: %VS_PATH%
call "%VS_PATH%\VC\Auxiliary\Build\vcvarsall.bat" x64

echo.
echo Compiling wasapi-capture.exe...
cl /EHsc /O2 native\wasapi-capture.cpp /Fe:com.nordowl.audiovis.sdPlugin\bin\wasapi-capture.exe /link ole32.lib

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo BUILD FAILED
    pause
    exit /b 1
)

echo.
echo SUCCESS: wasapi-capture.exe built
del wasapi-capture.obj 2>nul
pause
