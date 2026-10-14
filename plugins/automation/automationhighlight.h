/*
  automationhighlight.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONHIGHLIGHT_H
#define GAMMARAY_AUTOMATIONHIGHLIGHT_H

#include <QColor>
#include <QObject>
#include <QPointer>
#include <QRectF>
#include <QString>
#include <QVector>

namespace GammaRay {
namespace Automation {

/*!
 * Draws highlight boxes over elements inside the application's windows (like Playwright's
 * locator.highlight()): a transparent, input-transparent overlay per window, so the
 * highlight also shows in screenshots and videos. Overlays are created under a ProbeGuard
 * and are not part of the element tree.
 */
class Highlighter : public QObject
{
    Q_OBJECT
public:
    explicit Highlighter(QObject *parent = nullptr);
    ~Highlighter() override;

    struct Box
    {
        QRectF global; // in global coordinates
        QString label;
    };

    /*! Replaces the current highlight with @p boxes. */
    void show(const QVector<QObject *> &elements, const QString &label, const QColor &color);
    void hide();

private:
    QVector<QPointer<QObject>> m_overlays;
};

}
}

#endif
