# SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Sample application exercised by the qt-playwright example test suite.
# Standalone project: cmake -S . -B build -DCMAKE_PREFIX_PATH=<qt> && cmake --build build

cmake_minimum_required(VERSION 3.16)
project(qtpw_sampleapp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Widgets Qml Quick QuickControls2)

add_executable(
    sampleapp
    datawindow.cpp
    datawindow.h
    main.cpp
    qml.qrc
    widgetswindow.cpp
    widgetswindow.h
)
target_link_libraries(
    sampleapp
    PRIVATE Qt6::Widgets Qt6::Qml Qt6::Quick Qt6::QuickControls2
)
