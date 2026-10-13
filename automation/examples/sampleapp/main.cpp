// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

#include "widgetswindow.h"

#include <QApplication>
#include <QQmlApplicationEngine>
#include <QQuickStyle>

int main(int argc, char **argv)
{
    QApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("qtpw-sampleapp"));
    if (qEnvironmentVariableIsEmpty("QT_QUICK_CONTROLS_STYLE"))
        QQuickStyle::setStyle(QStringLiteral("Basic"));

    const QStringList args = app.arguments();
    const bool widgets = !args.contains(QStringLiteral("--qml-only"));
    const bool qml = !args.contains(QStringLiteral("--widgets-only"));

    std::unique_ptr<WidgetsWindow> window;
    if (widgets) {
        window.reset(new WidgetsWindow);
        window->move(0, 0);
        window->show();
    }

    QQmlApplicationEngine engine;
    if (qml)
        engine.load(QUrl(QStringLiteral("qrc:/Main.qml")));

    return app.exec();
}
