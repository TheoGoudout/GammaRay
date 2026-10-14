/*
  automationselectortest.cpp

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#include <plugins/automation/automationelement.h>
#include <plugins/automation/automationinput.h>
#include <plugins/automation/automationitemview.h>
#include <plugins/automation/automationselector.h>

#include <QCheckBox>
#include <QGroupBox>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QPushButton>
#include <QTableWidget>
#include <QTest>
#include <QTreeWidget>
#include <QVBoxLayout>

#ifdef QT_QUICK_LIB
#include <QQuickItem>
#endif

using namespace GammaRay::Automation;

class AutomationSelectorTest : public QObject
{
    Q_OBJECT
private:
    QVector<QObject *> query(const QString &selector, QObject *scope = nullptr)
    {
        QString error;
        const Selector sel = Selector::parse(selector, &error);
        if (!sel.isValid()) {
            qWarning() << error;
            return {};
        }
        SelectorEngine engine([this]() { return QVector<QObject *> { m_window.get() }; });
        return engine.query(sel, scope);
    }

    QStringList names(const QVector<QObject *> &objs)
    {
        QStringList result;
        for (auto o : objs)
            result.push_back(o->objectName());
        return result;
    }

    std::unique_ptr<QWidget> m_window;

private slots:
    void init()
    {
        m_window.reset(new QWidget);
        m_window->setObjectName(QStringLiteral("window"));
        auto layout = new QVBoxLayout(m_window.get());
        auto box = new QGroupBox(QStringLiteral("Login"), m_window.get());
        box->setObjectName(QStringLiteral("box"));
        auto boxLayout = new QVBoxLayout(box);
        auto user = new QLineEdit(box);
        user->setObjectName(QStringLiteral("user"));
        auto password = new QLineEdit(box);
        password->setObjectName(QStringLiteral("password"));
        password->setEchoMode(QLineEdit::Password);
        auto ok = new QPushButton(QStringLiteral("&Log in"), box);
        ok->setObjectName(QStringLiteral("ok"));
        ok->setEnabled(false);
        boxLayout->addWidget(user);
        boxLayout->addWidget(password);
        boxLayout->addWidget(ok);
        layout->addWidget(box);
        auto cancel = new QPushButton(QStringLiteral("Cancel"), m_window.get());
        cancel->setObjectName(QStringLiteral("cancel"));
        layout->addWidget(cancel);
        auto check = new QCheckBox(QStringLiteral("Remember"), m_window.get());
        check->setObjectName(QStringLiteral("remember"));
        check->setChecked(true);
        layout->addWidget(check);
        auto hidden = new QLabel(QStringLiteral("hidden label"), m_window.get());
        hidden->setObjectName(QStringLiteral("hiddenLabel"));
        hidden->hide();
        layout->addWidget(hidden);
        m_window->show();
        QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));
    }

    void cleanup()
    {
        m_window.reset();
    }

    void testParseErrors_data()
    {
        QTest::addColumn<QString>("selector");
        QTest::addColumn<QString>("error");
        QTest::newRow("empty") << QString() << "empty selector segment";
        QTest::newRow("empty segment") << "#a >> " << "empty selector segment";
        QTest::newRow("unbalanced") << "QPushButton[text=x" << "unbalanced brackets";
        QTest::newRow("unterminated string") << "text=\"abc" << "unterminated string";
        QTest::newRow("bad nth") << "nth=x" << "nth= expects an integer";
        QTest::newRow("bad visible") << "visible=maybe" << "visible= expects true or false";
        QTest::newRow("bad op") << "[a~b]" << "expected '=', '!=', '*=' or ']'";
        QTest::newRow("bad regex") << "text=/(/" << "invalid regular expression";
        QTest::newRow("two ids") << "#a#b" << "multiple ids";
        QTest::newRow("has unquoted") << "QWidget >> has=#a" << "expects a quoted selector";
        QTest::newRow("bad nested") << "QWidget >> has=\"[\"" << "unbalanced brackets";
        QTest::newRow("empty role") << "role=" << "role= expects a role name";
    }

    void testParseErrors()
    {
        QFETCH(QString, selector);
        QFETCH(QString, error);
        QString actual;
        QVERIFY(!Selector::parse(selector, &actual).isValid());
        QVERIFY2(actual.contains(error), qPrintable(actual));
    }

    void testParse()
    {
        QString error;
        const Selector sel = Selector::parse(QStringLiteral("QPushButton#ok[enabled=false][text*=\"Log\"] >> text=/a\\/b/i >> nth=-1"), &error);
        QVERIFY2(sel.isValid(), qPrintable(error));
        QCOMPARE(sel.segments.size(), 3);
        QCOMPARE(sel.segments[0].kind, Segment::Compound);
        QCOMPARE(sel.segments[0].type, QStringLiteral("QPushButton"));
        QCOMPARE(sel.segments[0].id, QStringLiteral("ok"));
        QCOMPARE(sel.segments[0].attributes.size(), 2);
        QCOMPARE(sel.segments[0].attributes[1].op, AttributeFilter::Contains);
        QCOMPARE(sel.segments[0].attributes[1].matcher.value, QStringLiteral("Log"));
        QCOMPARE(sel.segments[1].kind, Segment::Text);
        QCOMPARE(sel.segments[1].text.mode, ValueMatcher::Regex);
        QCOMPARE(sel.segments[1].text.regex.pattern(), QStringLiteral("a/b"));
        QVERIFY(sel.segments[1].text.matches(QStringLiteral("xA/By")));
        QCOMPARE(sel.segments[2].kind, Segment::Nth);
        QCOMPARE(sel.segments[2].nth, -1);
    }

    void testIdAndType()
    {
        QCOMPARE(names(query(QStringLiteral("#ok"))), QStringList { "ok" });
        QCOMPARE(names(query(QStringLiteral("QPushButton"))), (QStringList { "ok", "cancel" }));
        // base classes match too
        QCOMPARE(names(query(QStringLiteral("QAbstractButton"))), (QStringList { "ok", "cancel", "remember" }));
        QCOMPARE(names(query(QStringLiteral("QLineEdit#password"))), QStringList { "password" });
        QVERIFY(query(QStringLiteral("QLabel#ok")).isEmpty());
        QCOMPARE(query(QStringLiteral("*")).first(), m_window.get());
    }

    void testAttributes()
    {
        QCOMPARE(names(query(QStringLiteral("[echoMode=Password]"))), QStringList { "password" });
        QCOMPARE(names(query(QStringLiteral("QLineEdit[echoMode!=Password]"))), QStringList { "user" });
        QCOMPARE(names(query(QStringLiteral("QPushButton[enabled=false]"))), QStringList { "ok" });
        QCOMPARE(names(query(QStringLiteral("QAbstractButton[checked]"))), QStringList { "remember" });
        QCOMPARE(names(query(QStringLiteral("QPushButton[text=\"Cancel\"]"))), QStringList { "cancel" });
        // mnemonics are ignored when comparing
        QCOMPARE(names(query(QStringLiteral("QPushButton[text=\"Log in\"]"))), QStringList { "ok" });
        QCOMPARE(names(query(QStringLiteral("QPushButton[text*=ncel]"))), QStringList { "cancel" });
        QCOMPARE(names(query(QStringLiteral("QPushButton[text=/^C/]"))), QStringList { "cancel" });
        QCOMPARE(names(query(QStringLiteral("QWidget[objectName=user]"))), QStringList { "user" });
    }

    void testText()
    {
        // exact, case-sensitive, mnemonic-stripped
        QCOMPARE(names(query(QStringLiteral("text=\"Log in\""))), QStringList { "ok" });
        QVERIFY(query(QStringLiteral("text=\"log in\"")).isEmpty());
        // bare: case-insensitive substring
        QCOMPARE(names(query(QStringLiteral("text=LOG"))), (QStringList { "box", "ok" }));
        QCOMPARE(names(query(QStringLiteral("text=/^Rem/"))), QStringList { "remember" });
    }

    void testChainingAndNth()
    {
        QCOMPARE(names(query(QStringLiteral("#box >> QLineEdit"))), (QStringList { "user", "password" }));
        QVERIFY(query(QStringLiteral("#box >> #cancel")).isEmpty());
        QCOMPARE(names(query(QStringLiteral("QPushButton >> nth=1"))), QStringList { "cancel" });
        QCOMPARE(names(query(QStringLiteral("QPushButton >> first"))), QStringList { "ok" });
        QCOMPARE(names(query(QStringLiteral("QPushButton >> last"))), QStringList { "cancel" });
        QCOMPARE(names(query(QStringLiteral("QPushButton >> nth=-2"))), QStringList { "ok" });
        QVERIFY(query(QStringLiteral("QPushButton >> nth=5")).isEmpty());
        // an element is not its own descendant
        QVERIFY(query(QStringLiteral("#box >> #box")).isEmpty());
        // scoped query
        auto box = m_window->findChild<QGroupBox *>(QStringLiteral("box"));
        QCOMPARE(names(query(QStringLiteral("QPushButton"), box)), QStringList { "ok" });
    }

    void testVisible()
    {
        QCOMPARE(names(query(QStringLiteral("QLabel >> visible=false"))), QStringList { "hiddenLabel" });
        QVERIFY(query(QStringLiteral("#hiddenLabel >> visible=true")).isEmpty());
        QCOMPARE(query(QStringLiteral("QAbstractButton >> visible=true")).size(), 3);
    }

    void testRoleAndLabel()
    {
        QCOMPARE(names(query(QStringLiteral("role=button"))), (QStringList { "ok", "cancel" }));
        QCOMPARE(names(query(QStringLiteral("role=button[name=\"Log in\"]"))), QStringList { "ok" });
        // "..."i: case-insensitive substring; Qt role names work too
        QCOMPARE(names(query(QStringLiteral("role=button[name=\"CANC\"i]"))), QStringList { "cancel" });
        QCOMPARE(names(query(QStringLiteral("role=editabletext"))), (QStringList { "user", "password" }));
        QCOMPARE(names(query(QStringLiteral("role=checkbox[checked=true]"))), QStringList { "remember" });
        QVERIFY(query(QStringLiteral("role=checkbox[checked=false]")).isEmpty());
        QCOMPARE(names(query(QStringLiteral("role=button[disabled=true]"))), QStringList { "ok" });
        // hidden elements only with include-hidden
        QVERIFY(query(QStringLiteral("role=text[name=\"hidden label\"]")).isEmpty());
        QCOMPARE(names(query(QStringLiteral("role=text[name=\"hidden label\"][include-hidden]"))), QStringList { "hiddenLabel" });
        // label=: accessible name of inputs (the check box's own text here)
        QCOMPARE(names(query(QStringLiteral("label=\"remember\"i"))), QStringList { "remember" });
    }

    void testFilters()
    {
        // has / hasNot: descendants matching a nested selector
        QCOMPARE(names(query(QStringLiteral("QGroupBox >> has=\"#password\""))), QStringList { "box" });
        QVERIFY(query(QStringLiteral("QGroupBox >> hasNot=\"#password\"")).isEmpty());
        // hasText: own text or descendants'
        QCOMPARE(names(query(QStringLiteral("QWidget >> hasText=\"log in\"i >> nth=0"))), QStringList { "window" });
        QCOMPARE(names(query(QStringLiteral("QPushButton >> hasNotText=/Log/"))), QStringList { "cancel" });
        // and / or
        QCOMPARE(names(query(QStringLiteral("QAbstractButton >> and=\"[checked]\""))), QStringList { "remember" });
        QCOMPARE(names(query(QStringLiteral("#cancel >> or=\"#user\""))), (QStringList { "user", "cancel" })); // document order
        // or= after an empty step still adds its matches
        QCOMPARE(names(query(QStringLiteral("#doesNotExist >> or=\"#cancel\""))), QStringList { "cancel" });
    }

#ifdef QT_QUICK_LIB
    void testQuickVisualTree()
    {
        // visual children (parentItem) are found even without a QObject parent relation
        QQuickItem root;
        root.setObjectName(QStringLiteral("root"));
        auto child = new QQuickItem;
        child->setObjectName(QStringLiteral("child"));
        child->setParentItem(&root);
        QString error;
        SelectorEngine engine([&root]() { return QVector<QObject *> { &root }; });
        const auto result = engine.query(Selector::parse(QStringLiteral("#root >> Item"), &error));
        QCOMPARE(result.size(), 1);
        QCOMPARE(result.first(), child);
        // "QQuickItem" and the QML name "Item" both match
        QCOMPARE(engine.query(Selector::parse(QStringLiteral("QQuickItem#child"), &error)).size(), 1);
    }
#endif

    void testParseKey_data()
    {
        QTest::addColumn<QString>("spec");
        QTest::addColumn<int>("key");
        QTest::addColumn<int>("modifiers");
        QTest::addColumn<QString>("text");
        QTest::newRow("Enter") << "Enter" << int(Qt::Key_Return) << 0 << "\r";
        QTest::newRow("a") << "a" << int(Qt::Key_A) << 0 << "a";
        QTest::newRow("A") << "A" << int(Qt::Key_A) << 0 << "A";
        QTest::newRow("Control+A") << "Control+A" << int(Qt::Key_A) << int(Qt::ControlModifier) << "";
        QTest::newRow("Shift+ArrowDown") << "Shift+ArrowDown" << int(Qt::Key_Down) << int(Qt::ShiftModifier) << "";
        QTest::newRow("Control++") << "Control++" << int(Qt::Key_Plus) << int(Qt::ControlModifier) << "";
        QTest::newRow("F5") << "F5" << int(Qt::Key_F5) << 0 << "";
        QTest::newRow("Space") << "Space" << int(Qt::Key_Space) << 0 << " ";
    }

    void testParseKey()
    {
        QFETCH(QString, spec);
        QFETCH(int, key);
        QFETCH(int, modifiers);
        QFETCH(QString, text);
        Input::KeySpec k;
        QString error;
        QVERIFY2(Input::parseKey(spec, &k, &error), qPrintable(error));
        QCOMPARE(k.key, key);
        QCOMPARE(int(k.modifiers), modifiers);
        QCOMPARE(k.text, text);
    }

    void testParseKeyErrors()
    {
        Input::KeySpec k;
        QString error;
        QVERIFY(!Input::parseKey(QStringLiteral("Hyper+A"), &k, &error));
        QVERIFY(error.contains(QLatin1String("unknown modifier")));
        QVERIFY(!Input::parseKey(QStringLiteral("NoSuchKey"), &k, &error));
    }

    void testItemViewRows()
    {
        auto layout = m_window->layout();
        auto list = new QListWidget(m_window.get());
        list->setObjectName(QStringLiteral("list"));
        list->addItems({ QStringLiteral("Apple"), QStringLiteral("Banana"), QStringLiteral("Cherry") });
        layout->addWidget(list);
        auto tree = new QTreeWidget(m_window.get());
        tree->setObjectName(QStringLiteral("tree"));
        auto fruit = new QTreeWidgetItem(tree, { QStringLiteral("Fruit") });
        new QTreeWidgetItem(fruit, { QStringLiteral("Kiwi") });
        layout->addWidget(tree);
        auto table = new QTableWidget(2, 2, m_window.get());
        table->setObjectName(QStringLiteral("table"));
        for (int r = 0; r < 2; ++r)
            for (int c = 0; c < 2; ++c)
                table->setItem(r, c, new QTableWidgetItem(QStringLiteral("r%1c%2").arg(r).arg(c)));
        layout->addWidget(table);
        // added after init() showed the window
        for (QWidget *w : { static_cast<QWidget *>(list), static_cast<QWidget *>(tree), static_cast<QWidget *>(table) })
            w->show();
        m_window->resize(400, 600);
        QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));
        QCoreApplication::processEvents();

        // list rows: by role and name, in row order, with geometry from visualRect()
        auto rows = query(QStringLiteral("#list >> role=listitem"));
        QCOMPARE(rows.size(), 3);
        auto banana = qobject_cast<ViewItem *>(rows.at(1));
        QVERIFY(banana);
        QCOMPARE(banana->text(), QStringLiteral("Banana"));
        QCOMPARE(query(QStringLiteral("role=listitem[name=\"Cherry\"]")).size(), 1);
        QCOMPARE(Element::parent(banana), list);
        QVERIFY(Element::isVisible(banana));
        QCOMPARE(Element::globalGeometry(banana).toRect(),
                 QRect(list->viewport()->mapToGlobal(list->visualItemRect(list->item(1)).topLeft()), list->visualItemRect(list->item(1)).size()));
        // stand-ins are stable while the row exists, and go away with it
        QCOMPARE(query(QStringLiteral("#list >> role=listitem")).at(1), banana);
        const QPointer<ViewItem> guard(banana);
        delete list->takeItem(1);
        QCOMPARE(query(QStringLiteral("#list >> role=listitem")).size(), 2);
        QVERIFY(!guard);

        // tree rows: children only while expanded; level
        QCOMPARE(query(QStringLiteral("role=treeitem")).size(), 1);
        tree->expandItem(fruit);
        const auto kiwi = query(QStringLiteral("role=treeitem[name=\"Kiwi\"]"));
        QCOMPARE(kiwi.size(), 1);
        QCOMPARE(Element::accessible(kiwi.first()).level, 2);
        QCOMPARE(query(QStringLiteral("role=treeitem[name=\"Fruit\"] >> role=treeitem")), kiwi);

        // table rows with cells; a row is named after its cells
        QCOMPARE(query(QStringLiteral("#table >> role=row")).size(), 2);
        QCOMPARE(names(query(QStringLiteral("role=row[name=\"r1c0 r1c1\"] >> role=cell"))).size(), 2);
        QCOMPARE(Element::text(query(QStringLiteral("role=row >> nth=1 >> role=cell >> nth=1")).value(0)), QStringLiteral("r1c1"));
    }

    void testTypingUppercaseImpliesShift()
    {
        const auto k = Input::keyForCharacter(QLatin1Char('Q'));
        QCOMPARE(k.key, int(Qt::Key_Q));
        QCOMPARE(k.modifiers, Qt::ShiftModifier);
        QCOMPARE(k.text, QStringLiteral("Q"));
    }
};

QTEST_MAIN(AutomationSelectorTest)

#include "automationselectortest.moc"
