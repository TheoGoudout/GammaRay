// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ApplicationWindow {
    id: qmlWindow
    objectName: "qmlWindow"
    title: "QML Demo"
    x: 480
    y: 0
    width: 460
    height: 760
    visible: true

    property int loginAttempts: 0
    signal loggedIn(string user)

    function reset() {
        usernameField.text = ""
        passwordField.text = ""
        rememberCheck.checked = false
        statusLabel.text = "Please log in"
        return true
    }

    function addTodo(title) {
        todoModel.append({ title: title })
        return todoModel.count
    }

    function login() {
        loginAttempts++
        if (usernameField.text === "admin" && passwordField.text === "secret") {
            statusLabel.text = "Welcome, " + usernameField.text + "!"
            loggedIn(usernameField.text)
        } else {
            statusLabel.text = "Invalid credentials"
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 10
        spacing: 6

        // --- login form ---
        GroupBox {
            id: loginBox
            title: "Login"
            Layout.fillWidth: true

            ColumnLayout {
                anchors.fill: parent
                TextField {
                    id: usernameField
                    placeholderText: "User name"
                    Layout.fillWidth: true
                }
                TextField {
                    id: passwordField
                    echoMode: TextInput.Password
                    placeholderText: "Password"
                    Layout.fillWidth: true
                    onAccepted: qmlWindow.login()
                }
                CheckBox {
                    id: rememberCheck
                    text: "Remember me"
                }
                Button {
                    id: loginButton
                    text: "Login"
                    Accessible.description: "Sign in with your account"
                    enabled: usernameField.text.length > 0 && passwordField.text.length > 0
                    onClicked: qmlWindow.login()
                }
                Label {
                    id: statusLabel
                    text: "Please log in"
                }
            }
        }

        // --- todo list ---
        GroupBox {
            title: "Todos"
            Layout.fillWidth: true

            ColumnLayout {
                anchors.fill: parent
                ListView {
                    id: todoList
                    Layout.fillWidth: true
                    Layout.preferredHeight: 110
                    clip: true
                    model: ListModel {
                        id: todoModel
                        ListElement { title: "Write tests" }
                        ListElement { title: "Fix bugs" }
                        ListElement { title: "Ship it" }
                    }
                    delegate: ItemDelegate {
                        objectName: "todo_" + index
                        width: ListView.view.width
                        height: 34
                        text: model.title
                        highlighted: ListView.isCurrentItem
                        onClicked: todoList.currentIndex = index
                        onDoubleClicked: statusLabel.text = "Opened: " + model.title
                    }
                }
                RowLayout {
                    Layout.fillWidth: true
                    TextField {
                        id: newTodoField
                        placeholderText: "New todo"
                        Layout.fillWidth: true
                    }
                    Button {
                        id: addButton
                        text: "Add"
                        onClicked: {
                            if (newTodoField.text.length > 0) {
                                todoModel.append({ title: newTodoField.text })
                                newTodoField.text = ""
                            }
                        }
                    }
                    Button {
                        id: clearButton
                        text: "Clear all"
                        onClicked: confirmDialog.open()
                    }
                }
            }
        }

        // --- misc: slider, hover, drag, long list ---
        RowLayout {
            Layout.fillWidth: true
            Slider {
                id: volumeSlider
                from: 0
                to: 100
                stepSize: 1
                Layout.fillWidth: true
            }
            Label {
                id: volumeLabel
                text: "Volume: " + Math.round(volumeSlider.value)
            }
        }

        RowLayout {
            Layout.fillWidth: true
            ComboBox {
                id: fruitCombo
                model: ["Apple", "Banana", "Cherry"]
                onActivated: (index) => fruitLabel.text = "Fruit: " + textAt(index)
            }
            Label {
                id: fruitLabel
                text: "No fruit"
            }
            Rectangle {
                id: tapArea
                Layout.fillWidth: true
                Layout.preferredHeight: 30
                color: "lightgreen"
                Accessible.role: Accessible.Button
                Accessible.name: "Touch target"
                TapHandler {
                    acceptedDevices: PointerDevice.TouchScreen
                    onTapped: tapLabel.text = "Tapped by touch"
                }
                Label {
                    id: tapLabel
                    anchors.centerIn: parent
                    text: "Tap me"
                }
            }
        }

        Rectangle {
            id: hoverArea
            Layout.fillWidth: true
            Layout.preferredHeight: 30
            color: hoverHandler.hovered ? "lightsteelblue" : "lightgray"
            HoverHandler {
                id: hoverHandler
            }
            Label {
                id: hoverLabel
                anchors.centerIn: parent
                text: hoverHandler.hovered ? "Hovered" : "Not hovered"
            }
        }

        Item {
            id: dragArena
            Layout.fillWidth: true
            Layout.preferredHeight: 60
            Rectangle {
                id: draggable
                width: 50
                height: 50
                color: "orange"
                DragHandler {
                    id: dragHandler
                    yAxis.enabled: false
                }
            }
        }

        ListView {
            id: longList
            Layout.fillWidth: true
            Layout.fillHeight: true
            Layout.minimumHeight: 100
            clip: true
            model: 100
            delegate: Label {
                text: "Row " + index
                height: 24
            }
        }
    }

    Dialog {
        id: confirmDialog
        title: "Confirm"
        modal: true
        anchors.centerIn: parent
        standardButtons: Dialog.Ok | Dialog.Cancel
        Label {
            id: confirmText
            text: "Remove all " + todoModel.count + " todos?"
        }
        onAccepted: todoModel.clear()
    }
}
