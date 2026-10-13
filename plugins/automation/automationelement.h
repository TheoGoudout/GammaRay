/*
  automationelement.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONELEMENT_H
#define GAMMARAY_AUTOMATIONELEMENT_H

#include <QImage>
#include <QPointF>
#include <QRectF>
#include <QString>
#include <QStringList>
#include <QVector>

QT_BEGIN_NAMESPACE
class QObject;
class QWindow;
QT_END_NAMESPACE

namespace GammaRay {
namespace Automation {

/*!
 * Uniform view on QWidgets, QQuickItems, QWindows and plain QObjects.
 * All functions must be called on the GUI thread.
 */
namespace Element {

/*! Children in the combined QObject + QQuickItem visual tree, in document order. */
QVector<QObject *> children(QObject *obj);

/*! True if @p ancestor is a (combined tree) ancestor of @p obj, or @p obj itself. */
bool isSelfOrDescendantOf(QObject *obj, QObject *ancestor);

/*! The user-visible text (text, plainText, currentText, title, ...). */
QString text(const QObject *obj);
/*! Whether @p obj has any text-like property. */
bool hasText(const QObject *obj);
/*! Name of the property text() reads ("text", "title", ...), empty if none. */
QString textPropertyName(const QObject *obj);
/*! Parent in the combined QObject/visual tree. */
QObject *parent(QObject *obj);

/*! QML id of @p obj, if it was created from QML and has one. */
QString qmlId(QObject *obj);
/*! Names the type selector matches: C++ class chain, QQuick prefix-less names, QML type names. */
QStringList typeNames(const QObject *obj);
/*! Most specific human-readable type name (QML type if available). */
QString displayTypeName(const QObject *obj);

bool hasGeometry(const QObject *obj);
bool isVisible(const QObject *obj);
bool isEnabled(const QObject *obj);
/*! Bounding rectangle in global (screen) coordinates; null if no geometry. */
QRectF globalGeometry(const QObject *obj);

/*! Input target: the window receiving events for @p obj and @p localPos mapped into it. */
struct InputTarget
{
    QWindow *window = nullptr;
    QPointF windowPos;
};
InputTarget inputTarget(QObject *obj, QPointF localPos, QString *error);
/*! Where a click lands by default (local coordinates): the center of the clickable area. */
QPointF defaultClickPosition(const QObject *obj);
/*! Size of @p obj in its local coordinates. */
QSizeF localSize(const QObject *obj);

/*!
 * Checks whether a pointer event at @p localPos would actually reach @p obj
 * (not blocked by a modal window/popup or covered by another widget).
 * Returns a description of the blocker, or an empty string if not blocked.
 */
QString blockedBy(QObject *obj, QPointF localPos, const QVector<QObject *> &allObjects);

/*! Scrolls enclosing Flickables / QScrollAreas so that @p obj is fully visible (if possible).
 *  Returns true if anything was scrolled. */
bool scrollIntoView(QObject *obj);

/*! Moves keyboard focus to @p obj (and activates its window). */
bool focus(QObject *obj, QString *error);

/*! Renders @p obj (or its whole window if @p wholeWindow) to an image. */
QImage grab(QObject *obj, bool wholeWindow, QString *error);

/*! Accessibility information (from QAccessibleInterface), with ARIA-style role names. */
struct AccessibleInfo
{
    bool valid = false;
    QString role; // ARIA role name ("button", "textbox", ...) or Qt role name in lower case
    QString qtRole; // QAccessible::Role key in lower case ("pushbutton", "editabletext", ...)
    QString name;
    QString description;
    QString value;
    bool checked = false;
    bool checkable = false;
    bool disabled = false;
    bool expanded = false;
    bool expandable = false;
    bool selected = false;
    bool pressed = false;
    bool focused = false;
    bool readOnly = false;
    bool invisible = false;
    int level = 0;
};
AccessibleInfo accessible(QObject *obj);
/*! Activates Qt's accessibility support (needed for Qt Quick); done lazily on first use. */
void ensureAccessibilityActive();

/*! Accessible children of @p obj (QAccessibleInterface::child), as QObjects. */
QVector<QObject *> accessibleChildren(QObject *obj);

/*! Whether @p obj is an editable input: -1 not an input at all, 0 read-only/disabled, 1 editable. */
int editableState(const QObject *obj);

/*! Fraction (0..1) of @p obj's area that is inside its window and all clipping ancestors. */
qreal viewportRatio(QObject *obj);

/*! Stacking order rank of a top-level window (higher is on top). */
int stackingRank(QObject *window);
/*! The topmost visible window containing the global point @p global; @p localPos is set. */
QWindow *windowAt(QPointF global, QPointF *localPos);

/*! Removes keyboard focus from @p obj. */
void blur(QObject *obj);

/*! Visible top-level windows (QWidget windows and QWindows), as QObjects.
 *  Popups (menus, combo box lists, tool tips) only with @p includePopups. */
QVector<QObject *> topLevelWindows(bool includePopups = false);
/*! The window title of a top-level QWidget or QWindow. */
QString windowTitle(const QObject *window);

}
}
}

#endif
