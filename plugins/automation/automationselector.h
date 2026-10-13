/*
  automationselector.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONSELECTOR_H
#define GAMMARAY_AUTOMATIONSELECTOR_H

#include <QRegularExpression>
#include <QString>
#include <QVariant>
#include <QVector>

#include <functional>
#include <memory>

QT_BEGIN_NAMESPACE
class QObject;
QT_END_NAMESPACE

namespace GammaRay {
namespace Automation {

/*!
 * String matcher used by text= and [attr=value]:
 *  - "quoted"  exact match (case-sensitive)
 *  - bare      case-insensitive substring match (text=) / exact match ([attr=])
 *  - /re/flags regular expression (flags: i)
 */
struct ValueMatcher
{
    enum Mode
    {
        Exact,
        ContainsIgnoreCase,
        Regex
    };
    Mode mode = Exact;
    QString value;
    QRegularExpression regex;

    bool matches(const QString &s) const;
    QString toString() const;
};

struct AttributeFilter
{
    enum Op
    {
        Equals, // =
        NotEquals, // !=
        Contains // *=
    };
    QString name;
    Op op = Equals;
    ValueMatcher matcher;
    bool hasValue = true; // [checked] without a value means "truthy"
};

class Selector;

struct Segment
{
    enum Kind
    {
        Compound, // Type#id[attr=value]...
        Text, // text=...
        Nth, // nth=N, first, last
        Visible, // visible=true|false
        Role, // role=button[name="OK"][checked=true]   (accessibility role, like getByRole)
        Label, // label=...   (accessible name / buddy label of an input, like getByLabel)
        Has, // has="selector"      filters: keep matches with a descendant matching
        HasNot, // hasNot="selector"
        HasText, // hasText=...       keep matches whose own or descendants' text matches
        HasNotText, // hasNotText=...
        And, // and="selector"      keep matches also matched by selector
        Or, // or="selector"       add the elements matched by selector
        Handle // handle=N            the element with this handle (see HandleRegistry)
    };
    Kind kind = Compound;
    QString type; // empty = any
    QString id; // objectName or QML id
    QVector<AttributeFilter> attributes;
    ValueMatcher text;
    int nth = 0; // negative counts from the end, also the handle for Handle
    bool visible = true;
    QString role; // Role
    std::shared_ptr<Selector> nested; // Has, HasNot, And, Or

    /*! Filters apply to the current matches instead of searching descendants. */
    bool isFilter() const
    {
        return kind == Visible || kind == Has || kind == HasNot || kind == HasText || kind == HasNotText
            || kind == And || kind == Or;
    }
};

class Selector
{
public:
    /*! Parses @p selector; on failure returns an invalid selector and sets @p error. */
    static Selector parse(const QString &selector, QString *error);

    bool isValid() const
    {
        return !segments.isEmpty();
    }

    QVector<Segment> segments;
};

/*!
 * Evaluates selectors over the combined QObject/QQuickItem tree.
 *
 * Results are in document order (depth-first from the roots) and free of duplicates.
 */
class SelectorEngine
{
public:
    using RootProvider = std::function<QVector<QObject *>()>;
    using ObjectFilter = std::function<bool(QObject *)>;
    using HandleLookup = std::function<QObject *(qint64)>;

    explicit SelectorEngine(RootProvider roots, ObjectFilter accept = nullptr, HandleLookup lookup = nullptr);

    /*! Matches for @p selector; if @p scope is set the first segment only searches below it. */
    QVector<QObject *> query(const Selector &selector, QObject *scope = nullptr) const;

    /*! Does @p obj match a single compound/text/visible segment? */
    static bool matches(QObject *obj, const Segment &segment);

private:
    QVector<QObject *> allCandidates(QObject *scope) const;
    QVector<QObject *> applyFilter(const QVector<QObject *> &current, const Segment &seg) const;
    static QVector<QObject *> dropControlInternals(const QVector<QObject *> &matches);
    void collectDescendants(QObject *root, bool includeRoot, QVector<QObject *> &out,
                            QSet<QObject *> &seen) const;

    RootProvider m_roots;
    ObjectFilter m_accept;
    HandleLookup m_lookup;
};

}
}

#endif
