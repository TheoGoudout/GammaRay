# This file is part of GammaRay, the Qt application inspection and manipulation tool.
#
# SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
#
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Contact KDAB at <info@kdab.com> for commercial licensing options.
#

# Probe-side only: exposes a JSON-RPC-over-WebSocket API used by the
# qt-playwright end-to-end test library (see automation/ in the source tree).
if(NOT GAMMARAY_CLIENT_ONLY_BUILD)
    set(gammaray_automation_srcs
        automation.cpp
        automation.h
        automationcodegen.cpp
        automationcodegen.h
        automationelement.cpp
        automationelement.h
        automationhandles.cpp
        automationhandles.h
        automationinput.cpp
        automationinput.h
        automationjson.cpp
        automationjson.h
        automationrecorder.cpp
        automationrecorder.h
        automationselector.cpp
        automationselector.h
    )

    gammaray_add_plugin(
        gammaray_automation
        JSON
        gammaray_automation.json
        SOURCES
        ${gammaray_automation_srcs}
    )
    set_target_properties(gammaray_automation PROPERTIES DISABLE_PRECOMPILE_HEADERS ON)

    target_link_libraries(
        gammaray_automation
        gammaray_core
        Qt::Gui
        Qt::GuiPrivate
        Qt::WebSockets
    )
    if(TARGET Qt::Widgets)
        target_link_libraries(gammaray_automation Qt::Widgets)
    endif()
    if(TARGET Qt::Quick)
        target_link_libraries(gammaray_automation Qt::Qml Qt::Quick)
    endif()
endif()
