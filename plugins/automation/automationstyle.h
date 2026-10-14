/*
  automationstyle.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONSTYLE_H
#define GAMMARAY_AUTOMATIONSTYLE_H

#include <QJsonObject>
#include <QStringList>

QT_BEGIN_NAMESPACE
class QColor;
class QObject;
QT_END_NAMESPACE

namespace GammaRay {
namespace Automation {
namespace Style {

/*!
 * CSS-like computed style of an element, for toHaveCSS(): colors from the palette (which
 * style sheets feed) or QML color properties, fonts, opacity, size, visibility, cursor and
 * borders, formatted like a browser's getComputedStyle() ("rgb(255, 0, 0)", "18px", "700").
 */
QJsonObject computed(QObject *obj);

/*! A color the way browsers serialize computed colors. */
QString cssColor(const QColor &color);

/*!
 * The selected "options" of a selection control, for toHaveValues(): the selected rows of an
 * item view (in row order), or the current text of a combo box. @p ok is false for elements
 * that have no selection.
 */
QStringList selectedValues(QObject *obj, bool *ok);

}
}
}

#endif
