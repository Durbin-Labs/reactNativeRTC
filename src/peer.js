var util = require('util');
// var webrtcSupport = require('webrtcsupport');
var WebRTC = require('react-native-webrtc');
/**
 * rewrite: rtcpeerconnection module rewrite
 */
var PeerConnection = require('rtcpeerconnection');
var WildEmitter = require('wildemitter');
// var FileTransfer = require('filetransfer');

// the inband-v1 protocol is sending metadata inband in a serialized JSON object
// followed by the actual data. Receiver closes the datachannel upon completion

/** 
* rewrite: removed file transfer related stuff
*/
// var INBAND_FILETRANSFER_V1 = 'https://simplewebrtc.com/protocol/filetransfer#inband-v1';

function isAllTracksEnded(stream) {
    var isAllTracksEnded = true;
    stream.getTracks().forEach(function (t) {
        isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded;
    });
    return isAllTracksEnded;
}

var prioritizeVideoCodecs = function(payload) {
    var priority =  ["VP9","VP8","H.264","H.264"];  // ordered priority list, first = highest priority
    var ids = [];
    Object.keys(priority).forEach(function (key) {
        var id = findCodecId(payload, priority[key]);
        if (id) {
            ids.push(id);
        }
    });
    if (ids.length > 0 && payload && payload.sdp) {
        var sdp = payload.sdp;
        var m = sdp.match(/m=video\s(\d+)\s[A-Z\/]+\s([0-9\ ]+)/);
        if (m !== null && m.length === 3) {
            var candidates = m[2].split(" ");
            var prioritized = ids;
            Object.keys(candidates).forEach(function (key) {
                if (ids.indexOf(candidates[key]) === -1) {
                    //prioritized.push(121);
                    prioritized.push(candidates[key]);
                }
            });
            var mPrioritized = m[0].replace(m[2], prioritized.join(" "));
          //  logger.info("Setting video codec priority. \"%s\"", mPrioritized);
            payload.sdp = sdp.replace(m[0], mPrioritized);


        }
    }
    return payload;
};

var prioritizeAudioCodecs = function(payload) {
   // logger.info(payload);
    // ,"telephone-event" "opus"
    var priority = ["iLBC","PCMU","opus","telephone-event"];
    var ids = [];
    Object.keys(priority).forEach(function (key) {
        var id = findCodecId(payload, priority[key]);
        if (id) {
            ids.push(id);
        }
    });
    if (ids.length > 0 && payload && payload.sdp) {
        var sdp = payload.sdp;
        var m = sdp.match(/m=audio\s(\d+)\s[A-Z\/]+\s([0-9\ ]+)/);
        if (m !== null && m.length === 3) {
            var candidates = m[2].split(" ");
            var prioritized = ids;
            Object.keys(candidates).forEach(function (key) {
                if (ids.indexOf(candidates[key]) === -1) {
                    //prioritized.push(121);
                    prioritized.push(candidates[key]);
                }
            });
            var mPrioritized = m[0].replace(m[2], prioritized.join(" "));
        //    logger.info("audio codec Details: . \"%s\"", mPrioritized);
            //When Need To Modifiy Priority
            payload.sdp = sdp.replace(m[0], mPrioritized);
        }
    }
  /*  var maxAvgBitRate = config.maxAverageBitRate || 0;
    if (maxAvgBitRate > 0) {
        var id = findCodecId(details, "opus");
        if (id && details.payload && details.payload.sdp) {
            details.payload.sdp = alterFmtpConfig(details.payload.sdp, id, {"maxaveragebitrate": maxAvgBitRate});
        }
    }*/
    return payload;
};


function Peer(options) {
    var self = this;

    // call emitter constructor
    WildEmitter.call(this);

    this.id = options.id;
    this.parent = options.parent;
    this.type = options.type || 'video';
    this.oneway = options.oneway || false;
    this.sharemyscreen = options.sharemyscreen || false;
    this.browserPrefix = options.prefix;
    this.stream = options.stream;
    this.enableDataChannels = options.enableDataChannels === undefined ? this.parent.config.enableDataChannels : options.enableDataChannels;
    this.receiveMedia = options.receiveMedia || this.parent.config.receiveMedia;
    this.channels = {};
    this.sid = options.sid || Date.now().toString();
    // Create an RTCPeerConnection via the polyfill
    this.pc = new PeerConnection(this.parent.config.peerConnectionConfig, this.parent.config.peerConnectionConstraints);
    this.pc.on('ice', this.onIceCandidate.bind(this));
    this.pc.on('endOfCandidates', function (event) {
        self.send('endOfCandidates', event);
    });
    this.pc.on('offer', function (offer) {
        offer = prioritizeVideoCodecs(offer);
        offer = prioritizeAudioCodecs(offer);
        if (self.parent.config.nick) offer.nick = self.parent.config.nick;
        self.send('offer', offer);
    });
    this.pc.on('answer', function (answer) {
        if (self.parent.config.nick) answer.nick = self.parent.config.nick;
        self.send('answer', answer);
    });
    this.pc.on('addStream', this.handleRemoteStreamAdded.bind(this));
    /**
     * rewrite: no data channel needed
     */
    // this.pc.on('addChannel', this.handleDataChannelAdded.bind(this));
    this.pc.on('removeStream', this.handleStreamRemoved.bind(this));
    // Just fire negotiation needed events for now
    // When browser re-negotiation handling seems to work
    // we can use this as the trigger for starting the offer/answer process
    // automatically. We'll just leave it be for now while this stabalizes.
    this.pc.on('negotiationNeeded', this.emit.bind(this, 'negotiationNeeded'));
    this.pc.on('iceConnectionStateChange', this.emit.bind(this, 'iceConnectionStateChange'));
    this.pc.on('iceConnectionStateChange', function () {
        switch (self.pc.iceConnectionState) {
        case 'failed':
            // currently, in chrome only the initiator goes to failed
            // so we need to signal this to the peer
            if (self.pc.pc.localDescription.type === 'offer') {
                self.parent.emit('iceFailed', self);
                self.send('connectivityError');
            }
            break;
        }
    });
    this.pc.on('signalingStateChange', this.emit.bind(this, 'signalingStateChange'));
    this.logger = this.parent.logger;

    // handle screensharing/broadcast mode
    if (options.type === 'screen') {
        if (this.parent.localScreens && this.parent.localScreens[0] && this.sharemyscreen) {
            this.logger.log('adding local screen stream to peer connection');
            this.pc.addStream(this.parent.localScreens[0]);
            this.broadcaster = options.broadcaster;
        }
    } else {
        this.parent.localStreams.forEach(function (stream) {
            self.pc.addStream(stream);
        });
    }

    /**
     * rewrite: removed
     */
    // this.on('channelOpen', function (channel) {
    //     if (channel.protocol === INBAND_FILETRANSFER_V1) {
    //         channel.onmessage = function (event) {
    //             var metadata = JSON.parse(event.data);
    //             var receiver = new FileTransfer.Receiver();
    //             receiver.receive(metadata, channel);
    //             self.emit('fileTransfer', metadata, receiver);
    //             receiver.on('receivedFile', function (file, metadata) {
    //                 receiver.channel.close();
    //             });
    //         };
    //     }
    // });

    // proxy events to parent
    this.on('*', function () {
        self.parent.emit.apply(self.parent, arguments);
    });
}

util.inherits(Peer, WildEmitter);

Peer.prototype.handleMessage = function (message) {
    var self = this;

    /**
     * probably needs rewrite
     */
    this.logger.log('getting', message.type, message);

    if (message.prefix) this.browserPrefix = message.prefix;

    if (message.type === 'offer') {
        if (!this.nick) this.nick = message.payload.nick;
        delete message.payload.nick;
        this.pc.handleOffer(message.payload, function (err) {
            if (err) {
                return;
            }
            // auto-accept
            self.pc.answer(function (err, sessionDescription) {
                //self.send('answer', sessionDescription);
            });
        });
    } else if (message.type === 'answer') {
        if (!this.nick) this.nick = message.payload.nick;
        delete message.payload.nick;
        this.pc.handleAnswer(message.payload);
    } else if (message.type === 'candidate') {
        this.pc.processIce(message.payload);
    } else if (message.type === 'connectivityError') {
        this.parent.emit('connectivityError', self);
    } else if (message.type === 'mute') {
        this.parent.emit('mute', {id: message.from, name: message.payload.name});
    } else if (message.type === 'unmute') {
        this.parent.emit('unmute', {id: message.from, name: message.payload.name});
    } else if (message.type === 'endOfCandidates') {
        // Edge requires an end-of-candidates. Since only Edge will have mLines or tracks on the
        // shim this will only be called in Edge.
        var mLines = this.pc.pc.transceivers || [];
        mLines.forEach(function (mLine) {
            if (mLine.iceTransport) {
                mLine.iceTransport.addRemoteCandidate({});
            }
        });
    }
};

/**
 * rewrite: removed webrtcSupport.prefix
 */
// send via signalling channel
Peer.prototype.send = function (messageType, payload) {
    var message = {
        to: this.id,
        sid: this.sid,
        broadcaster: this.broadcaster,
        roomType: this.type,
        type: messageType,
        payload: payload,
        // prefix: webrtcSupport.prefix
    };
    /** 
     * probably needs rewrite: replace or add logger in appropriate place
     */
    this.logger.log('sending', messageType, message);
    this.parent.emit('message', message);
};

/**
 * rewrite: removed data channel related stuff
 */
// send via data channel
// returns true when message was sent and false if channel is not open
// Peer.prototype.sendDirectly = function (channel, messageType, payload) {
//     var message = {
//         type: messageType,
//         payload: payload
//     };
//     this.logger.log('sending via datachannel', channel, messageType, message);
//     var dc = this.getDataChannel(channel);
//     if (dc.readyState != 'open') return false;
//     dc.send(JSON.stringify(message));
//     return true;
// };

/**
 * rewrite: removed data channel related stuff
 */
// Internal method registering handlers for a data channel and emitting events on the peer
// Peer.prototype._observeDataChannel = function (channel) {
//     var self = this;
//     channel.onclose = this.emit.bind(this, 'channelClose', channel);
//     channel.onerror = this.emit.bind(this, 'channelError', channel);
//     channel.onmessage = function (event) {
//         self.emit('channelMessage', self, channel.label, JSON.parse(event.data), channel, event);
//     };
//     channel.onopen = this.emit.bind(this, 'channelOpen', channel);
// };

/**
 * rewrite: removed data channel related stuff
 */
// Fetch or create a data channel by the given name
// Peer.prototype.getDataChannel = function (name, opts) {
//     if (!webrtcSupport.supportDataChannel) return this.emit('error', new Error('createDataChannel not supported'));
//     var channel = this.channels[name];
//     opts || (opts = {});
//     if (channel) return channel;
//     // if we don't have one by this label, create it
//     channel = this.channels[name] = this.pc.createDataChannel(name, opts);
//     this._observeDataChannel(channel);
//     return channel;
// };

Peer.prototype.onIceCandidate = function (candidate) {
    if (this.closed) return;
    if (candidate) {
        var pcConfig = this.parent.config.peerConnectionConfig;
        /**
         * rewrite: removed browser specific code
         */
        // if (webrtcSupport.prefix === 'moz' && pcConfig && pcConfig.iceTransports &&
        //         candidate.candidate && candidate.candidate.candidate &&
        //         candidate.candidate.candidate.indexOf(pcConfig.iceTransports) < 0) {
        //     this.logger.log('Ignoring ice candidate not matching pcConfig iceTransports type: ', pcConfig.iceTransports);
        // } else {
        //     this.send('candidate', candidate);
        // }
        this.send('candidate', candidate);
    } else {
        this.logger.log("End of candidates.");
    }
};

Peer.prototype.start = function () {
    var self = this;

    // well, the webrtc api requires that we either
    // a) create a datachannel a priori
    // b) do a renegotiation later to add the SCTP m-line
    // Let's do (a) first...
    /**
     * rewrite: removed data channel related stuff
     */
    // if (this.enableDataChannels) {
    //     this.getDataChannel('simplewebrtc');
    // }

    this.pc.offer(this.receiveMedia, function (err, sessionDescription) {
        self.send('offer', sessionDescription);
    });
};

Peer.prototype.icerestart = function () {
    var constraints = this.receiveMedia;
    constraints.mandatory.IceRestart = true;
    this.pc.offer(constraints, function (err, success) { });
};

Peer.prototype.end = function () {
    if (this.closed) return;
    this.pc.close();
    this.handleStreamRemoved();
};


Peer.prototype.handleRemoteStreamAdded = function (event) {
    var self = this;
    if (this.stream) {
        this.logger.warn('Already have a remote stream');
    } else {
        this.stream = event.stream;

        this.stream.getTracks().forEach(function (track) {
            track.addEventListener('ended', function () {
                if (isAllTracksEnded(self.stream)) {
                    self.end();
                }
            });
        });

        this.parent.emit('peerStreamAdded', this);
    }
};

Peer.prototype.handleStreamRemoved = function () {
    var peerIndex = this.parent.peers.indexOf(this);
    if (peerIndex > -1) {
        this.parent.peers.splice(peerIndex, 1);
        this.closed = true;
        this.parent.emit('peerStreamRemoved', this);
    }
};

/**
 * rewrite: remove datachannel related stuff
 */
// Peer.prototype.handleDataChannelAdded = function (channel) {
//     this.channels[channel.label] = channel;
//     this._observeDataChannel(channel);
// };

/**
 * rewrite: removed sendFile
 */
// Peer.prototype.sendFile = function (file) {
//     var sender = new FileTransfer.Sender();
//     var dc = this.getDataChannel('filetransfer' + (new Date()).getTime(), {
//         protocol: INBAND_FILETRANSFER_V1
//     });
//     // override onopen
//     dc.onopen = function () {
//         dc.send(JSON.stringify({
//             size: file.size,
//             name: file.name
//         }));
//         sender.send(file, dc);
//     };
//     // override onclose
//     dc.onclose = function () {
//         console.log('sender received transfer');
//         sender.emit('complete');
//     };
//     return sender;
// };

module.exports = Peer;
