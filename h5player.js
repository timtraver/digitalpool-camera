!function(a) {
    define(function(require, b, c) {
        function d() {
            var a = location.hostname;
            return /:/.test(a) ? /\[|\]/.test(a) ? a : "[" + a + "]" : a
        }
        function e() {
            return "" == location.port ? "http:" == location.protocol ? 80 : 443 : location.port
        }
        function f() {
            return "" == location.port ? webCaps.is_show_Rtsp_over_tls && F.RTSPOverTlsEnable ? "http:" == location.protocol ? 554 : 443 : "http:" == location.protocol ? 80 : 443 : location.port
        }
        function g() {
            return webCaps.is_show_Rtsp_over_tls && F.RTSPOverTlsEnable ? "wss" : "http:" === location.protocol ? "ws" : "wss"
        }
        function h(a, b, c) {
            return a.indexOf("264") > -1 && b === !1 && c > z ? "video" : "canvas"
        }
        function i(a, b, c) {
            o.DigitalCertificate.getCertsInfo(a, b, "General").done(function(a) {
                c && c(a.params && a.params.List)
            }).fail(function() {})
        }
        function j(a, b, c, d) {
            o.DigitalCertificate[c && "exportCRL" || "exportCert"](a, b).done(function(a) {
                var b = Base64.decode(a.params[c ? "CRL" : "Cert"]);
                d && d(b)
            }).fail(function() {}).always(function() {})
        }
        function k(a, b, c) {
            var d = new Blob([a],{
                type: "application/x-x509-ca-cert"
            })
              , e = document.createElement("a");
            e.href = window.URL.createObjectURL(d),
            e.download = b,
            document.body.appendChild(e),
            e.click(),
            setTimeout(function() {
                window.URL.revokeObjectURL(e.href),
                document.body.removeChild(e),
                c && c()
            }, 1e3)
        }
        var l, m, n = require("jsCore/rpcLogin"), o = require("jsCore/rpc"), p = require("jsCore/pluginCanvas"), q = {}, r = null, s = {}, t = null, u = null, v = null, w = null, x = null, y = null, z = 921600, A = !1, B = null, C = null, D = .5, E = !0, F = c.exports = {
            wsprotocol: "http:" === location.protocol ? "ws" : "wss",
            rtspprotocol: "rtsp",
            ip: d(),
            port: e(),
            RTSPOverTlsEnable: !1,
            mode: "canvas",
            audioPreviewVolume: 0,
            audioPlaybackVolume: 0,
            debug: !1,
            speed: 1,
            currTime: 0,
            totalTime: 0,
            init: function() {
                v = this,
                (null === r || 0 === r.length) && (jQuery("#h5playerContainer").remove(),
                jQuery("body").append('<div id="h5playerContainer" style="background:rgb(0,0,0);position:absolute;top:-10000px;width:1px;height:1px"></div>'),
                r = a("#h5playerContainer"),
                r.append('<canvas id="canvasplayer" style="position:absolute;" width="300" height="300"></canvas>'),
                r.append('<div id="downloadCert" class="download-plugin fn-hide" style="height:150px;margin-top: -75px;background-color: #000;z-index: 11000">                          <div style="margin-top: 59px;">                            <a id="downloadCert_a" onclick="downloadCert()" href="javascript:void(0)">                            <span class="download-plugin-icon"></span>                            <span t="sys.DownloadCer"></span></a>                          <div>                        </div>'),
                r.append('<div id="videoLoading" class="video_loading"></div>'),
                r.append('<video id="videoplayer" style="position:absolute;" width="100%" height="100%"></video>'),
                r.append('<div id="h5playerProptip" class="h5playerProptip" style="display:none"></div>'),
                r.append('<div id="h5playertip" class="h5playertip" style="display:none"><span id="h5playertipWord"></span><i class="i-close"></i></div>'),
                r.translation(),
                q.canvasplayer = r.find("#canvasplayer"),
                q.videoplayer = r.find("#videoplayer"),
                t = r.find("#videoLoading"),
                u = r.find("#downloadCert"),
                u.hide(),
                s.canvasplayerObj = q.canvasplayer[0],
                s.videoplayerObj = q.videoplayer[0],
                r.find("#h5playertip i.i-close").on("click", function() {
                    r.find("#h5playertip").hide().find("#h5playertipWord").text("")
                }))
            },
            cover: function(a, b) {
                var c = a;
                if (c.is(":visible")) {
                    var d = c.offset()
                      , e = c.width()
                      , f = c.height();
                    r.css({
                        width: e,
                        height: f,
                        top: d.top,
                        left: d.left,
                        "z-index": 10002
                    }),
                    e = r.width(),
                    f = r.height();
                    var g, h, i, j, k, l;
                    b ? (g = b.split("*")[0],
                    h = b.split("*")[1]) : (g = q.canvasplayer.attr("width"),
                    h = q.canvasplayer.attr("height")),
                    e * h > g * f ? (i = g * f / h,
                    j = f,
                    k = 0,
                    l = (e * h - g * f) / (2 * h)) : g * f > e * h ? (i = e,
                    j = h * e / g,
                    k = (g * f - e * h) / (2 * g),
                    l = 0) : (k = 0,
                    l = 0,
                    i = e,
                    j = f),
                    e - i > 0 && 2 > e - i && (i = e,
                    l = 0),
                    "canvas" === F.mode && (b && q.canvasplayer.attr("width", g).attr("height", h),
                    q.canvasplayer.css({
                        top: k,
                        left: l,
                        width: i,
                        height: j
                    })),
                    r.show()
                }
            },
            _coverContainer: function(a) {
                var b = a;
                if (b.is(":visible")) {
                    var c = b.offset()
                      , d = b.width()
                      , e = b.height();
                    r.css({
                        width: d,
                        height: e,
                        top: c.top,
                        left: c.left,
                        "z-index": 10002
                    }),
                    "canvas" === F.mode && q.canvasplayer.css({
                        top: 0,
                        left: 0,
                        width: 300,
                        height: 300
                    }).prop("width", 300).prop("height", 300),
                    r.show()
                }
            },
            playPreview: function(b, c, d, e, h, i) {
                if (i && a("#canvas").hide(),
                E = !1,
                F._coverContainer(d),
                r.show().find("#h5playerProptip").hide().text(""),
                q.canvasplayer.hide(),
                q.videoplayer.hide(),
                F.cover(d),
                !n.chkAuthority("Monitor_01"))
                    return void r.find("#h5playerProptip").show().text(tl("com.NoVideoAuthoityTip"));
                t.show(),
                u.hide();
                var j = n.getLoginInfo()
                  , k = [F.setMode(c)];
                webCaps.is_show_Rtsp_over_tls && k.push(o.ConfigManager.getConfig("MediaEncrypt")),
                a.when.apply(a, k).then(function() {
                    var k = arguments[0];
                    if (webCaps.is_show_Rtsp_over_tls) {
                        var l = arguments[1];
                        F.RTSPOverTlsEnable = l.RTSPOverTls.Enable,
                        F.port = f(),
                        v.wsprotocol = g()
                    }
                    F.mode = k.mode,
                    (k.encodeMode.indexOf("265") > -1 || 1 == k.encodeSmart) && 3840 === k.width && 2160 === k.height && !e && (c = 1);
                    var m = {
                        wsURL: v.wsprotocol + "://" + v.ip + ":" + v.port + "/rtspoverwebsocket",
                        rtspURL: v.rtspprotocol + "://" + v.ip + ":" + v.port + "/cam/realmonitor?channel=" + b + "&subtype=" + c,
                        decodeMode: F.mode,
                        username: j.username,
                        password: j.password
                    };
                    E !== !0 && (w = new PlayerControl(m),
                    w.on("DecodeStart", function(a) {
                        a.h265 === !0 && 3840 === a.width && 2160 === a.height && e ? e() : F.cover(d, a.width + "*" + a.height)
                    }),
                    w.on("PlayStart", function() {
                        t.hide();
                        var a = {};
                        "canvas" === F.mode ? (q.canvasplayer.show(),
                        a.width = q.canvasplayer.attr("width") - 0,
                        a.height = q.canvasplayer.attr("height") - 0) : (q.videoplayer.show(),
                        a.width = s.videoplayerObj.videoWidth - 0,
                        a.height = s.videoplayerObj.videoHeight - 0),
                        h && (i && (p.hide(),
                        webApp.resolution.x = a.width,
                        webApp.resolution.y = a.height,
                        p.cover("#attr_video", webApp.resolution.x + "*" + webApp.resolution.y),
                        jQuery('[data-page="camera_attr"] [cfg="VideoInBacklight"]').hasClass("current") ? jQuery('[data-page="camera_attr"] [sel-for=onSelBLMode]').change() : jQuery('[data-page="camera_attr"] [cfg="VideoInWhiteBalance"]').hasClass("current") && jQuery('[data-page="camera_attr"] #attr_wb_mode').change()),
                        h.resolve(a))
                    }),
                    w.on("ResolutionChanged", function(a) {
                        B = a.width * a.height,
                        F._rePlay(C, A, B, b, c, d, e, h, i),
                        F.cover(d, a.width + "*" + a.height)
                    }),
                    w.on("MSEResolutionChanged", function(a) {
                        B = a.width * a.height,
                        F._rePlay(C, A, B, b, c, d, e, h, i),
                        F.cover(d, a.width + "*" + a.height)
                    }),
                    w.on("FrameTypeChange", function(a) {
                        C = a,
                        F._rePlay(C, A, B, b, c, d, e, h, i)
                    }),
                    w.on("audioChange", function() {
                        e && F._rePlay(C, A, B, b, c, d, h, e, i)
                    }),
                    w.on("Error", function(j) {
                        if (j)
                            switch (j.errorCode) {
                            case 101:
                                e && 0 === c && e();
                                break;
                            case 404:
                                t.hide(),
                                r.show().find("#h5playerProptip").show().text(webApp.GLOBAL_PRIVACY ? tl("com.PreviewMaskMode") : tl("com.ResLimOpenVideoFailTip"));
                                break;
                            case 201:
                                e && r.find("#h5playertip").show().find("#h5playertipWord").text(tl("med.notSupportAudioType"));
                                break;
                            case 202:
                                webCaps.is_show_Rtsp_over_tls && a.when(o.ConfigManager.getConfig("MediaEncrypt")).then(function(j) {
                                    var k = j.RTSPOverTls.Enable;
                                    if (k !== F.RTSPOverTlsEnable)
                                        F.RTSPOverTlsEnable = k,
                                        F.port = f(),
                                        v.wsprotocol = g(),
                                        F._rePlay(C, A, B, b, c, d, h, e, i);
                                    else if (k && F.RTSPOverTlsEnable)
                                        return a("#canvas").hide(),
                                        void u.show()
                                })
                            }
                    }),
                    w.on("WorkerReady", function() {
                        w.connect()
                    }),
                    w.init(s.canvasplayerObj, s.videoplayerObj),
                    w.setAudioVolume(e ? F.audioPreviewVolume : 0))
                })
            },
            _rePlay: function(a, b, c, d, e, f, g, i, j) {
                var k = h(a, b, c);
                F.hide(),
                F.mode = k,
                F.playPreview(d, e, f, g, i, j)
            },
            _rePlayback: function(a, b, c, d) {
                F.hide(),
                F.playback(a, b, c, d)
            },
            playback: function(b, c, d, e) {
                var h = 0
                  , i = 0;
                F.mode = "canvas",
                F.totalTime = 0,
                F.currTime = 0,
                F._coverContainer(c),
                u.hide(),
                t.show(),
                r.find("#h5playerProptip").hide().text("");
                var j = n.getLoginInfo()
                  , k = {
                    wsURL: v.wsprotocol + "://" + v.ip + ":" + v.port + "/rtspoverwebsocket",
                    rtspURL: v.rtspprotocol + "://" + v.ip + ":" + v.port + "/" + b.FilePath,
                    decodeMode: F.mode,
                    username: j.username,
                    password: j.password
                };
                w = new PlayerControl(k),
                w.on("PlayStart", function() {
                    t.hide(),
                    q.canvasplayer.show(),
                    r.off("mouseenter").off("mouseleave").on("mouseenter", function() {
                        y.show()
                    }).on("mouseleave", function() {
                        y.hide()
                    })
                }),
                w.on("DecodeStart", function(a) {
                    F.cover(c, a.width + "*" + a.height)
                }),
                w.on("GetFrameRate", function() {}),
                w.on("UpdateCanvas", function(a) {
                    0 === h && (h = a.timestamp),
                    F.currTime = a.timestamp - h,
                    F.currTime !== i && (i = F.currTime,
                    v.processControlsBar(F.currTime))
                }),
                w.on("Error", function(h) {
                    if (h)
                        switch (h.errorCode) {
                        case 101:
                            F.currTime < F.totalTime * D && (d(),
                            r.show().find("#h5playerProptip").show().text(tl("net.streamMaximumDelay")),
                            w.close());
                            break;
                        case 201:
                            r.find("#h5playertip").show().find("#h5playertipWord").text(tl("med.notSupportAudioType"));
                            break;
                        case 202:
                            webCaps.is_show_Rtsp_over_tls && a.when(o.ConfigManager.getConfig("MediaEncrypt")).then(function(h) {
                                var i = h.RTSPOverTls.Enable;
                                if (i !== F.RTSPOverTlsEnable)
                                    F.RTSPOverTlsEnable = i,
                                    F.port = f(),
                                    v.wsprotocol = g(),
                                    F._rePlayback(b, c, d, e);
                                else if (i && F.RTSPOverTlsEnable)
                                    return a("#canvas").hide(),
                                    void u.show()
                            })
                        }
                }),
                w.init(s.canvasplayerObj, s.videoplayerObj),
                w.connect(),
                F._initPlayBackControlsBar(b.Duration, e)
            },
            initControlsBar: function() {
                null === y && (r.append('<div id="controlsBarContainer" class="playback-controlsbar-container" style="display:none"></div>'),
                y = r.find("#controlsBarContainer"),
                y.append('<div id="controlsBar" style="width:600px;margin-top:14px;margin-left:50px;"></div'),
                x = y.find("#controlsBar"),
                y.append('<div class="playback-controlsbar-process"><span id="currentTimeSpan">00:00:01</span>/<span id="totalTimeSpan">24:24:24</span></div>'),
                l = y.find("#currentTimeSpan"),
                m = y.find("#totalTimeSpan"))
            },
            _initPlayBackControlsBar: function(a, b) {
                F.totalTime = a,
                x.slider({
                    min: 1,
                    max: a,
                    dragEnable: !1,
                    prompt: !1,
                    name: "playback",
                    title: function(a) {
                        return window.global.formatSeconds(a)
                    },
                    icons: !1,
                    complete: function(a, c) {
                        F.playByTime(c.value),
                        b()
                    }
                }),
                m.text(window.global.formatSeconds(a)),
                F.processControlsBar(0)
            },
            processControlsBar: function(a) {
                null !== y && (a = a || 0,
                x.slider("value", a),
                l.text(window.global.formatSeconds(a)))
            },
            showAutoSwitch: function(a, b) {
                a && r.find("#h5playertip").show().find("#h5playertipWord").text(b)
            },
            playByTime: function(a) {
                w.playByTime(a)
            },
            play: function() {
                return w ? (w.play(),
                !0) : !1
            },
            playFF: function(a) {
                w && (w.playFF(a),
                F.speed = a)
            },
            pause: function() {
                return w ? (w.pause(),
                !0) : !1
            },
            stop: function() {
                return w ? (w.stop(),
                !0) : !1
            },
            capture: function() {
                var a = new Date
                  , b = a.getFullYear() + "" + global.leftPad(a.getMonth() + 1, "0", 2) + global.leftPad(a.getDate(), "0", 2);
                b += "_",
                b = b + global.leftPad(a.getHours(), "0", 2) + "" + global.leftPad(a.getMinutes(), "0", 2) + global.leftPad(a.getSeconds(), "0", 2),
                w && w.capture(b)
            },
            setAudioVolume: function(a, b) {
                b === !0 ? F.audioPlaybackVolume = a : F.audioPreviewVolume = a,
                w && w.setAudioVolume(a)
            },
            hide: function() {
                "h5" === webApp.playMode && (r.hide(),
                r.find("#h5playerProptip").hide().text(""),
                r.off(),
                q.canvasplayer.hide(),
                q.videoplayer.hide(),
                r.find("#h5playertip").hide().find("#h5playertipWord").text(""),
                w && (E = !0,
                w.close()),
                t && t.hide(),
                y && y.hide(),
                w = null)
            },
            destroy: function() {},
            setMode: function(b) {
                return b = b || 0,
                a.Deferred(function(a) {
                    var c = ["Encode", "SmartEncode"]
                      , d = "canvas";
                    o.ConfigManager.getConfig(c).done(function(c) {
                        var e = null;
                        if (A = !1,
                        0 === b)
                            e = c[0].params.table[0].MainFormat[0],
                            A = c[1].result && c[1].params.table[0].Enable;
                        else {
                            var f = b - 1;
                            b > 3 && (f = b - 4),
                            e = c[0].params.table[0].ExtraFormat[f],
                            A = c[1].result && c[1].params.table[0].Extra && c[1].params.table[0].Extra[f]
                        }
                        B = e.Video.Height * e.Video.Width,
                        C = e.Video.Compression,
                        d = h(C, A, B);
                        var g = {};
                        g.mode = d,
                        g.width = e.Video.Width,
                        g.height = e.Video.Height,
                        g.encodeMode = e.Video.Compression,
                        g.encodeSmart = A,
                        a.resolve(g)
                    }).fail(function() {
                        a.reject()
                    })
                }).promise()
            },
            visible: function(a) {
                r && r.css("visibility", a ? "visible" : "hidden")
            }
        };
        window.downloadCert = function() {
            var a = "DefRootCACert"
              , b = null
              , c = null
              , d = null
              , e = null;
            ability.get("SupportCertificateSet").done(function(f) {
                if (f && f.Support)
                    c = f.SupportCertImport || 200,
                    d = f.SupportCACertImport,
                    e = f.SupportCrlImport,
                    i(0, c + d + e, function(c) {
                        for (var d = 0, e = c.length; e > d; d++)
                            if (c[d].Type == a) {
                                b = c[d].CertSN;
                                break
                            }
                        j(b, "General", !1, function(a) {
                            k(a, "RootCert.cer", function() {})
                        })
                    });
                else {
                    var g = "RootCert.cer"
                      , h = document.createElement("a");
                    h.setAttribute("href", "/RPC2_DownloadRootCert/RootCert.cer"),
                    h.setAttribute("download", g),
                    document.body.appendChild(h),
                    h.click(),
                    h.remove()
                }
            })
        }
    })
}(jQuery);

