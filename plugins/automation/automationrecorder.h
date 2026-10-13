/*
  automationrecorder.h

  This file is part of GammaRay, the Qt application inspection and manipulation tool.

  SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>

  SPDX-License-Identifier: GPL-2.0-or-later

  Contact KDAB at <info@kdab.com> for commercial licensing options.
*/

#ifndef GAMMARAY_AUTOMATIONRECORDER_H
#define GAMMARAY_AUTOMATIONRECORDER_H

#include <QElapsedTimer>
#include <QImage>
#include <QObject>
#include <QRectF>
#include <QTimer>

#include <functional>

namespace GammaRay {
namespace Automation {

/*!
 * Records the application's windows as a stream of image frames.
 *
 * All visible top-level windows (including popups) are composed onto one canvas at
 * their screen positions, optionally with a title bar per window and the synthesized
 * mouse pointer drawn on top. A frame is only emitted when the picture changed;
 * every frame carries its timestamp so the consumer can produce a constant frame rate.
 *
 * Wire format of a frame (little endian): "QTPW", format byte ('J' jpeg / 'P' png),
 * 3 padding bytes, uint32 recording id, float64 milliseconds since start, image data.
 */
class Recorder : public QObject
{
    Q_OBJECT
public:
    struct Options
    {
        int fps = 25;
        qreal scale = 1.0; // ignored when size is set
        QSize size; // fit the canvas into this size (letterboxed)
        int quality = 90; // jpeg quality
        bool chrome = true; // draw window title bars
        bool cursor = true; // draw the mouse pointer
    };
    using FrameSink = std::function<bool(const QByteArray &frame)>; // false: frame dropped (congestion)

    Recorder(quint32 id, const Options &options, FrameSink sink, QObject *parent = nullptr);

    quint32 id() const
    {
        return m_id;
    }
    QSize frameSize() const
    {
        return m_frameSize;
    }
    QByteArray format() const
    {
        return m_format;
    }
    int framesSent() const
    {
        return m_framesSent;
    }
    qint64 elapsed() const
    {
        return m_clock.elapsed();
    }

    /*! Starts capturing; the first frame is sent right away. */
    void start();
    /*! Sends a final frame and stops. */
    void stop();

private:
    void captureFrame(bool force);
    QImage compose();
    void computeCanvas();

    quint32 m_id;
    Options m_options;
    FrameSink m_sink;
    QTimer m_timer;
    QElapsedTimer m_clock;
    QRectF m_canvas; // in global coordinates (including title bar space)
    qreal m_scale = 1.0;
    QPointF m_offset; // letterboxing offset in frame pixels
    QSize m_frameSize;
    QByteArray m_format;
    QImage m_lastFrame;
    int m_framesSent = 0;
};

}
}

#endif
