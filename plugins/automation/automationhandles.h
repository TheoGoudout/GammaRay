/*
  automationhandles.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONHANDLES_H
#define GAMMARAY_AUTOMATIONHANDLES_H

#include <QHash>
#include <QPointer>

namespace GammaRay {
namespace Automation {

/*!
 * Stable element handles.
 *
 * Every object handed out to a client gets a small integer id that stays the same for
 * the lifetime of the object. Ids are never reused, so a handle to a destroyed object
 * reliably resolves to nullptr ("stale") even if a new object reuses the address.
 */
class HandleRegistry
{
public:
    /*! Returns the handle of @p obj, allocating one if needed. 0 for nullptr. */
    qint64 handleFor(QObject *obj);
    /*! Returns the live object for @p handle, or nullptr if unknown or destroyed. */
    QObject *object(qint64 handle) const;
    /*! Returns the existing handle for @p obj without allocating one (0 if none). */
    qint64 existingHandle(const QObject *obj) const;
    /*! Forget @p obj (call when it is destroyed); returns its handle (0 if none). */
    qint64 objectDestroyed(const QObject *obj);

private:
    qint64 m_nextHandle = 1;
    QHash<qint64, QPointer<QObject>> m_objects;
    QHash<const QObject *, qint64> m_handles;
};

}
}

#endif
