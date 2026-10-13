/*
  automationselector.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include "automationselector.h"
#include "automationelement.h"

#include <QMetaProperty>
#include <QObject>
#include <QSet>

using namespace GammaRay;
using namespace GammaRay::Automation;

static QString stripMnemonic(const QString &s)
{
    if (!s.contains(QLatin1Char('&')))
        return s;
    QString out;
    out.reserve(s.size());
    for (int i = 0; i < s.size(); ++i) {
        if (s.at(i) == QLatin1Char('&')) {
            if (i + 1 < s.size() && s.at(i + 1) == QLatin1Char('&'))
                out.push_back(s.at(++i));
            continue;
        }
        out.push_back(s.at(i));
    }
    return out;
}

bool ValueMatcher::matches(const QString &s) const
{
    switch (mode) {
    case Exact:
        return s.simplified() == value.simplified();
    case ContainsIgnoreCase:
        return s.simplified().contains(value.simplified(), Qt::CaseInsensitive);
    case Regex:
        return regex.match(s).hasMatch();
    }
    return false;
}

QString ValueMatcher::toString() const
{
    switch (mode) {
    case Exact:
        return QLatin1Char('"') + value + QLatin1Char('"');
    case ContainsIgnoreCase:
        return value;
    case Regex:
        return QLatin1Char('/') + regex.pattern() + QLatin1Char('/');
    }
    return QString();
}

namespace {
class Parser
{
public:
    explicit Parser(const QString &s)
        : m_s(s)
    {
    }

    // splits at top-level ">>", honoring quotes, brackets and /regex/ literals
    QStringList splitSegments(QString *error) const
    {
        QStringList parts;
        QString current;
        QChar quote;
        bool inRegex = false;
        int depth = 0;
        for (int i = 0; i < m_s.size(); ++i) {
            const QChar c = m_s.at(i);
            if (!quote.isNull() || inRegex) {
                current.push_back(c);
                if (c == QLatin1Char('\\') && i + 1 < m_s.size()) {
                    current.push_back(m_s.at(++i));
                    continue;
                }
                if (!quote.isNull() && c == quote)
                    quote = QChar();
                else if (inRegex && c == QLatin1Char('/'))
                    inRegex = false;
                continue;
            }
            if (c == QLatin1Char('"') || c == QLatin1Char('\'')) {
                quote = c;
            } else if (c == QLatin1Char('/') && previousNonSpace(current) == QLatin1Char('=')) {
                inRegex = true;
            } else if (c == QLatin1Char('[')) {
                ++depth;
            } else if (c == QLatin1Char(']')) {
                --depth;
            } else if (depth == 0 && c == QLatin1Char('>') && i + 1 < m_s.size() && m_s.at(i + 1) == QLatin1Char('>')) {
                parts.push_back(current.trimmed());
                current.clear();
                ++i;
                continue;
            }
            current.push_back(c);
        }
        if (!quote.isNull())
            *error = QStringLiteral("unterminated string");
        else if (inRegex)
            *error = QStringLiteral("unterminated regular expression");
        else if (depth != 0)
            *error = QStringLiteral("unbalanced brackets");
        parts.push_back(current.trimmed());
        for (const auto &p : std::as_const(parts)) {
            if (p.isEmpty() && error->isEmpty())
                *error = QStringLiteral("empty selector segment");
        }
        return parts;
    }

    static QChar previousNonSpace(const QString &s)
    {
        for (int i = s.size() - 1; i >= 0; --i) {
            if (!s.at(i).isSpace())
                return s.at(i);
        }
        return QChar();
    }

    // parses a value: "quoted", 'quoted', /regex/flags or a bare word up to one of @p terminators
    static bool parseValue(const QString &s, int &pos, ValueMatcher::Mode bareMode, const QString &terminators,
                           ValueMatcher *out, QString *error)
    {
        while (pos < s.size() && s.at(pos).isSpace())
            ++pos;
        if (pos >= s.size()) {
            out->mode = bareMode;
            out->value.clear();
            return true;
        }
        const QChar c = s.at(pos);
        if (c == QLatin1Char('"') || c == QLatin1Char('\'')) {
            QString v;
            ++pos;
            while (pos < s.size() && s.at(pos) != c) {
                if (s.at(pos) == QLatin1Char('\\') && pos + 1 < s.size())
                    ++pos;
                v.push_back(s.at(pos++));
            }
            if (pos >= s.size()) {
                *error = QStringLiteral("unterminated string");
                return false;
            }
            ++pos; // closing quote
            out->mode = ValueMatcher::Exact;
            out->value = v;
            return true;
        }
        if (c == QLatin1Char('/')) {
            QString pattern;
            ++pos;
            while (pos < s.size() && s.at(pos) != QLatin1Char('/')) {
                if (s.at(pos) == QLatin1Char('\\') && pos + 1 < s.size()) {
                    if (s.at(pos + 1) != QLatin1Char('/'))
                        pattern.push_back(s.at(pos));
                    ++pos;
                }
                pattern.push_back(s.at(pos++));
            }
            if (pos >= s.size()) {
                *error = QStringLiteral("unterminated regular expression");
                return false;
            }
            ++pos; // closing slash
            QRegularExpression::PatternOptions opts;
            while (pos < s.size() && s.at(pos).isLetter()) {
                if (s.at(pos) == QLatin1Char('i'))
                    opts |= QRegularExpression::CaseInsensitiveOption;
                else if (s.at(pos) == QLatin1Char('s'))
                    opts |= QRegularExpression::DotMatchesEverythingOption;
                else if (s.at(pos) == QLatin1Char('m'))
                    opts |= QRegularExpression::MultilineOption;
                ++pos;
            }
            out->mode = ValueMatcher::Regex;
            out->regex = QRegularExpression(pattern, opts);
            if (!out->regex.isValid()) {
                *error = QStringLiteral("invalid regular expression: %1").arg(out->regex.errorString());
                return false;
            }
            return true;
        }
        QString v;
        while (pos < s.size() && !terminators.contains(s.at(pos)))
            v.push_back(s.at(pos++));
        out->mode = bareMode;
        out->value = v.trimmed();
        return true;
    }

    static bool isIdentChar(QChar c)
    {
        return c.isLetterOrNumber() || c == QLatin1Char('_') || c == QLatin1Char('-');
    }

    static bool parseCompound(const QString &s, Segment *seg, QString *error)
    {
        seg->kind = Segment::Compound;
        int pos = 0;
        // type: identifier, may contain '.', ':' and '/' (e.g. QtQuick.Controls/Button, Foo::Bar)
        if (pos < s.size() && s.at(pos) == QLatin1Char('*')) {
            ++pos;
        } else {
            while (pos < s.size() && (isIdentChar(s.at(pos)) || s.at(pos) == QLatin1Char('.') || s.at(pos) == QLatin1Char(':') || s.at(pos) == QLatin1Char('/')))
                seg->type.push_back(s.at(pos++));
        }
        while (pos < s.size()) {
            const QChar c = s.at(pos);
            if (c == QLatin1Char('#')) {
                ++pos;
                QString id;
                if (pos < s.size() && (s.at(pos) == QLatin1Char('"') || s.at(pos) == QLatin1Char('\''))) {
                    ValueMatcher m;
                    if (!parseValue(s, pos, ValueMatcher::Exact, QString(), &m, error))
                        return false;
                    id = m.value;
                } else {
                    while (pos < s.size() && (isIdentChar(s.at(pos)) || s.at(pos) == QLatin1Char('.') || s.at(pos) == QLatin1Char(':')))
                        id.push_back(s.at(pos++));
                }
                if (id.isEmpty()) {
                    *error = QStringLiteral("expected an id after '#'");
                    return false;
                }
                if (!seg->id.isEmpty()) {
                    *error = QStringLiteral("multiple ids in one segment");
                    return false;
                }
                seg->id = id;
            } else if (c == QLatin1Char('[')) {
                ++pos;
                AttributeFilter attr;
                while (pos < s.size() && s.at(pos).isSpace())
                    ++pos;
                while (pos < s.size() && (isIdentChar(s.at(pos)) || s.at(pos) == QLatin1Char('.')))
                    attr.name.push_back(s.at(pos++));
                if (attr.name.isEmpty()) {
                    *error = QStringLiteral("expected a property name after '['");
                    return false;
                }
                while (pos < s.size() && s.at(pos).isSpace())
                    ++pos;
                if (pos < s.size() && s.at(pos) == QLatin1Char(']')) {
                    attr.hasValue = false;
                } else {
                    if (s.mid(pos, 2) == QLatin1String("!=")) {
                        attr.op = AttributeFilter::NotEquals;
                        pos += 2;
                    } else if (s.mid(pos, 2) == QLatin1String("*=")) {
                        attr.op = AttributeFilter::Contains;
                        pos += 2;
                    } else if (pos < s.size() && s.at(pos) == QLatin1Char('=')) {
                        attr.op = AttributeFilter::Equals;
                        pos += 1;
                    } else {
                        *error = QStringLiteral("expected '=', '!=', '*=' or ']' in attribute filter");
                        return false;
                    }
                    if (!parseValue(s, pos, ValueMatcher::Exact, QStringLiteral("]"), &attr.matcher, error))
                        return false;
                    while (pos < s.size() && s.at(pos).isSpace())
                        ++pos;
                }
                if (pos >= s.size() || s.at(pos) != QLatin1Char(']')) {
                    *error = QStringLiteral("expected ']'");
                    return false;
                }
                ++pos;
                seg->attributes.push_back(attr);
            } else {
                *error = QStringLiteral("unexpected character '%1' in \"%2\"").arg(c).arg(s);
                return false;
            }
        }
        return true;
    }

    static bool parseSegment(const QString &s, Segment *seg, QString *error)
    {
        if (s == QLatin1String("first")) {
            seg->kind = Segment::Nth;
            seg->nth = 0;
            return true;
        }
        if (s == QLatin1String("last")) {
            seg->kind = Segment::Nth;
            seg->nth = -1;
            return true;
        }
        if (s.startsWith(QLatin1String("nth="))) {
            bool ok = false;
            seg->kind = Segment::Nth;
            seg->nth = s.mid(4).trimmed().toInt(&ok);
            if (!ok)
                *error = QStringLiteral("nth= expects an integer");
            return ok;
        }
        if (s.startsWith(QLatin1String("visible="))) {
            const QString v = s.mid(8).trimmed();
            seg->kind = Segment::Visible;
            if (v != QLatin1String("true") && v != QLatin1String("false")) {
                *error = QStringLiteral("visible= expects true or false");
                return false;
            }
            seg->visible = v == QLatin1String("true");
            return true;
        }
        if (s.startsWith(QLatin1String("text="))) {
            seg->kind = Segment::Text;
            int pos = 5;
            if (!parseValue(s, pos, ValueMatcher::ContainsIgnoreCase, QString(), &seg->text, error))
                return false;
            if (pos < s.size() && !s.mid(pos).trimmed().isEmpty()) {
                *error = QStringLiteral("unexpected trailing characters after text value");
                return false;
            }
            if (seg->text.mode != ValueMatcher::Regex && seg->text.value.isEmpty()) {
                *error = QStringLiteral("text= expects a value");
                return false;
            }
            return true;
        }
        return parseCompound(s, seg, error);
    }

private:
    QString m_s;
};
}

Selector Selector::parse(const QString &selector, QString *error)
{
    Selector result;
    error->clear();
    Parser parser(selector);
    const QStringList parts = parser.splitSegments(error);
    if (!error->isEmpty()) {
        *error = QStringLiteral("invalid selector \"%1\": %2").arg(selector, *error);
        return result;
    }
    for (const QString &part : parts) {
        Segment seg;
        if (!Parser::parseSegment(part, &seg, error)) {
            *error = QStringLiteral("invalid selector \"%1\": %2").arg(selector, *error);
            return Selector();
        }
        result.segments.push_back(seg);
    }
    return result;
}

SelectorEngine::SelectorEngine(RootProvider roots, ObjectFilter accept)
    : m_roots(std::move(roots))
    , m_accept(std::move(accept))
{
}

static QString propertyValueString(QObject *obj, const QString &name, bool *exists, bool *truthy)
{
    const QByteArray n = name.toUtf8();
    const QMetaObject *mo = obj->metaObject();
    const int idx = mo->indexOfProperty(n.constData());
    QVariant v;
    if (idx >= 0) {
        const QMetaProperty prop = mo->property(idx);
        v = prop.read(obj);
        if (prop.isEnumType() && v.isValid()) {
            const int iv = v.toInt();
            *exists = true;
            *truthy = iv != 0;
            const QByteArray key = prop.isFlagType() ? prop.enumerator().valueToKeys(iv)
                                                     : QByteArray(prop.enumerator().valueToKey(iv));
            return key.isEmpty() ? QString::number(iv) : QString::fromLatin1(key);
        }
    } else {
        v = obj->property(n.constData());
        if (!v.isValid() && name == QLatin1String("id")) {
            const QString id = Element::qmlId(obj);
            *exists = !id.isEmpty();
            *truthy = *exists;
            return id;
        }
    }
    *exists = v.isValid();
    if (!v.isValid()) {
        *truthy = false;
        return QString();
    }
    switch (v.typeId()) {
    case QMetaType::Bool:
        *truthy = v.toBool();
        return v.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    case QMetaType::Double:
    case QMetaType::Float:
        *truthy = v.toDouble() != 0.0;
        return QString::number(v.toDouble(), 'g', 15);
    default:
        break;
    }
    if (v.metaType().flags() & QMetaType::PointerToQObject) {
        auto o = *reinterpret_cast<QObject *const *>(v.constData());
        *truthy = o != nullptr;
        return o ? o->objectName() : QString();
    }
    const QString s = v.toString();
    *truthy = v.canConvert<bool>() ? v.toBool() : !s.isEmpty();
    return s;
}

static bool attributeMatches(QObject *obj, const AttributeFilter &attr)
{
    bool exists = false;
    bool truthy = false;
    const QString actual = propertyValueString(obj, attr.name, &exists, &truthy);
    if (!attr.hasValue)
        return truthy;
    if (!exists)
        return attr.op == AttributeFilter::NotEquals;

    bool matched = false;
    switch (attr.op) {
    case AttributeFilter::Equals:
    case AttributeFilter::NotEquals: {
        if (attr.matcher.mode == ValueMatcher::Regex) {
            matched = attr.matcher.matches(actual);
        } else {
            bool ok1 = false;
            bool ok2 = false;
            const double a = actual.toDouble(&ok1);
            const double b = attr.matcher.value.toDouble(&ok2);
            if (ok1 && ok2)
                matched = qFuzzyCompare(a + 1.0, b + 1.0);
            else
                matched = actual == attr.matcher.value || stripMnemonic(actual) == attr.matcher.value;
        }
        if (attr.op == AttributeFilter::NotEquals)
            matched = !matched;
        break;
    }
    case AttributeFilter::Contains:
        matched = attr.matcher.mode == ValueMatcher::Regex ? attr.matcher.matches(actual)
                                                          : actual.contains(attr.matcher.value);
        break;
    }
    return matched;
}

bool SelectorEngine::matches(QObject *obj, const Segment &segment)
{
    switch (segment.kind) {
    case Segment::Nth:
        return true;
    case Segment::Visible:
        return Element::isVisible(obj) == segment.visible;
    case Segment::Text: {
        if (!Element::hasText(obj))
            return false;
        const QString t = Element::text(obj);
        return segment.text.matches(t) || segment.text.matches(stripMnemonic(t));
    }
    case Segment::Compound:
        break;
    }

    if (!segment.type.isEmpty() && !Element::typeNames(obj).contains(segment.type))
        return false;
    if (!segment.id.isEmpty() && obj->objectName() != segment.id && Element::qmlId(obj) != segment.id)
        return false;
    for (const auto &attr : segment.attributes) {
        if (!attributeMatches(obj, attr))
            return false;
    }
    return true;
}

// A control's own "text" is usually rendered by internal child items with the same text
// (e.g. a QML Button's contentItem/label). Report only the control itself.
QVector<QObject *> SelectorEngine::dropControlInternals(const QVector<QObject *> &matches)
{
    const QSet<QObject *> matchSet(matches.cbegin(), matches.cend());
    QVector<QObject *> result;
    for (QObject *obj : matches) {
        bool internal = false;
        const QString t = Element::text(obj);
        int depth = 0;
        for (QObject *p = Element::parent(obj); p && depth < 8 && !internal; p = Element::parent(p), ++depth) {
            internal = matchSet.contains(p) && Element::textPropertyName(p) == QLatin1String("text") && Element::text(p) == t;
        }
        if (!internal)
            result.push_back(obj);
    }
    return result;
}

void SelectorEngine::collectDescendants(QObject *root, bool includeRoot, QVector<QObject *> &out,
                                        QSet<QObject *> &seen) const
{
    // iterative pre-order DFS, so deep QML trees don't blow the stack
    QVector<QPair<QObject *, bool>> stack;
    stack.push_back({ root, includeRoot });
    while (!stack.isEmpty()) {
        const auto entry = stack.takeLast();
        QObject *obj = entry.first;
        if (entry.second) {
            if (seen.contains(obj))
                continue;
            seen.insert(obj);
            out.push_back(obj);
        }
        const auto kids = Element::children(obj);
        for (auto it = kids.crbegin(); it != kids.crend(); ++it) {
            QObject *child = *it;
            if (seen.contains(child) || (m_accept && !m_accept(child)))
                continue;
            stack.push_back({ child, true });
        }
    }
}

QVector<QObject *> SelectorEngine::query(const Selector &selector, QObject *scope) const
{
    QVector<QObject *> current;
    bool started = false;

    auto allCandidates = [&]() {
        QVector<QObject *> all;
        QSet<QObject *> seen;
        if (scope) {
            collectDescendants(scope, false, all, seen);
        } else {
            const auto roots = m_roots();
            for (QObject *root : roots) {
                if (!m_accept || m_accept(root))
                    collectDescendants(root, true, all, seen);
            }
        }
        return all;
    };

    for (const Segment &seg : selector.segments) {
        if (seg.kind == Segment::Nth) {
            if (!started) {
                current = allCandidates();
                started = true;
            }
            const int idx = seg.nth < 0 ? current.size() + seg.nth : seg.nth;
            if (idx >= 0 && idx < current.size())
                current = { current.at(idx) };
            else
                current.clear();
            continue;
        }
        if (seg.kind == Segment::Visible && started) {
            QVector<QObject *> filtered;
            for (QObject *obj : std::as_const(current)) {
                if (matches(obj, seg))
                    filtered.push_back(obj);
            }
            current = filtered;
            continue;
        }

        QVector<QObject *> candidates;
        if (!started) {
            candidates = allCandidates();
        } else {
            QSet<QObject *> seen;
            for (QObject *obj : std::as_const(current)) {
                // an element is not its own descendant, but may be one of a previous match
                const bool alreadySeen = seen.contains(obj);
                seen.insert(obj);
                collectDescendants(obj, false, candidates, seen);
                if (!alreadySeen)
                    seen.remove(obj);
            }
        }
        started = true;
        current.clear();
        for (QObject *obj : std::as_const(candidates)) {
            if (matches(obj, seg))
                current.push_back(obj);
        }
        if (seg.kind == Segment::Text)
            current = dropControlInternals(current);
        if (current.isEmpty())
            break;
    }
    return current;
}
