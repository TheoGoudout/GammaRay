#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Builds GammaRay (with the automation plugin), the sample app and the qt-playwright
# client, then runs the example suite headless (QT_QPA_PLATFORM=offscreen).
#
#   QT_PREFIX=/opt/Qt/6.8.3/gcc_64 automation/run-e2e.sh [playwright test args...]
#
# Environment:
#   QT_PREFIX            Qt 6 installation (with Qt WebSockets); else Qt is searched as usual
#   GAMMARAY_BUILD_DIR   GammaRay build directory to (re)use   [build-automation]
#   SKIP_GAMMARAY_BUILD  set to 1 to use an existing build as is
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD=${GAMMARAY_BUILD_DIR:-$ROOT/build-automation}
SAMPLE_BUILD=$ROOT/automation/examples/sampleapp/build
PREFIX_ARGS=()
if [[ -n "${QT_PREFIX:-}" ]]; then PREFIX_ARGS=(-DCMAKE_PREFIX_PATH="$QT_PREFIX"); fi
GENERATOR=()
if command -v ninja >/dev/null; then GENERATOR=(-G Ninja); fi

if [[ "${SKIP_GAMMARAY_BUILD:-0}" != 1 ]]; then
  echo "== Building GammaRay in $BUILD"
  if [[ ! -f "$BUILD/CMakeCache.txt" ]]; then
    cmake -S "$ROOT" -B "$BUILD" "${GENERATOR[@]}" "${PREFIX_ARGS[@]}" -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      -DGAMMARAY_BUILD_DOCS=OFF -DBUILD_TESTING=OFF -DGAMMARAY_MULTI_BUILD=OFF
  fi
  cmake --build "$BUILD"
fi
GAMMARAY="$BUILD/bin/gammaray"
if ! ls "$BUILD"/lib*/gammaray/*/*/gammaray_automation* >/dev/null 2>&1; then
  echo "error: the gammaray_automation plugin was not built (is Qt WebSockets installed?)" >&2
  exit 1
fi

echo "== Building the sample app"
cmake -S "$ROOT/automation/examples/sampleapp" -B "$SAMPLE_BUILD" "${GENERATOR[@]}" "${PREFIX_ARGS[@]}" -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build "$SAMPLE_BUILD"

echo "== Building the qt-playwright client"
(cd "$ROOT/automation/client" && npm ci --no-audit --no-fund && npm test)

echo "== Running the example suite"
cd "$ROOT/automation/examples"
rm -rf node_modules/qt-playwright # file: dependency is copied (install-links), refresh it
npm ci --no-audit --no-fund
export QT_PLAYWRIGHT_GAMMARAY="$GAMMARAY"
export QTPW_SAMPLEAPP="$SAMPLE_BUILD/sampleapp"
export QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software
npx playwright test "$@"
