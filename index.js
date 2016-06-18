'use strict';

var fs = require('fs');
var path = require('path');
var util = require('util');
var common = require('winston/lib/winston/common');
var Transport = require('winston').Transport;
var Stream = require('stream').Stream;
var os = require('os');
var winston = require('winston');
var zlib = require('zlib');
var async = require('async');
var ms = require('ms');

//
// ### function DailyRotateFile (options)
// #### @options {Object} Options for this instance.
// Constructor function for the DailyRotateFile transport object responsible
// for persisting log messages and metadata to one or more files.
//
var DailyRotateFile = module.exports = function (options)
{
    Transport.call(this, options);

    //
    // Helper function which throws an `Error` in the event
    // that any of the rest of the arguments is present in `options`.
    //
    function throwIf(target /* , illegal... */)
    {
        Array.prototype.slice.call(arguments, 1).forEach(function (name)
        {
            if (options[name])
            {
                throw new Error('Cannot set ' + name + ' and ' + target + 'together');
            }
        });
    }

    if (options.filename || options.dirname)
    {
        throwIf('filename or dirname', 'stream');
        this._basename = this.filename = options.filename ?
            path.basename(options.filename) :
            'winston.log';

        this.dirname = options.dirname || path.dirname(options.filename);
        this.options = options.options || {flags: 'a'};

        //
        // "24 bytes" is maybe a good value for logging lines.
        //
        this.options.highWaterMark = this.options.highWaterMark || 24;
    } else if (options.stream)
    {
        throwIf('stream', 'filename', 'maxsize');
        this._stream = options.stream;
        var self = this;
        this._stream.on('error', function (error)
        {
            self.emit('error', error);
        });

        //
        // We need to listen for drain events when
        // write() returns false. This can make node
        // mad at times.
        //
        this._stream.setMaxListeners(Infinity);
    } else
    {
        throw new Error('Cannot log to file without filename or stream.');
    }

    this.json = options.json !== false;
    this.colorize = options.colorize || false;
    this.maxsize = options.maxsize || null;
    this.maxFiles = options.maxFiles || null;
    this.label = options.label || null;
    this.prettyPrint = options.prettyPrint || false;
    this.showLevel = options.showLevel === undefined ? true : options.showLevel;
    this.timestamp = options.timestamp ? options.timestamp : true;
    this.datePattern = options.datePattern ? options.datePattern : '.yyyy-MM-dd';
    this.depth = options.depth || null;
    this.eol = options.eol || os.EOL;
    this.maxRetries = options.maxRetries || 2;
    this.prepend = options.prepend || false;
    this.zippedArchive = options.zippedArchive || false;
    this.olderThan = options.olderThan || null;

    if (this.json)
    {
        this.stringify = options.stringify;
    }

    //
    // Internal state variables representing the number
    // of files this instance has created and the current
    // size (in bytes) of the current logfile.
    //
    this._size = 0;
    this._created = 0;
    this._buffer = [];
    this._draining = false;
    this._failures = 0;
    this._archive = false;

    var now = new Date();
    this._year = now.getFullYear();
    this._month = now.getMonth();
    this._date = now.getDate();
    this._hour = now.getHours();
    this._minute = now.getMinutes();
    this._token = /d{1,4}|m{1,4}|yy(?:yy)?|([HhM])\1?/g;

    var pad = function (val, len)
    {
        val = String(val);
        len = len || 2;
        while (val.length < len)
        {
            val = '0' + val;
        }
        return val;
    };

    this.getFormattedDate = function ()
    {
        var flags = {
            yy: String(this._year).slice(2),
            yyyy: this._year,
            M: this._month + 1,
            MM: pad(this._month + 1),
            d: this._date,
            dd: pad(this._date),
            H: this._hour,
            HH: pad(this._hour),
            m: this._minute,
            mm: pad(this._minute)
        };
        return this.datePattern.replace(this._token, function ($0)
        {
            return $0 in flags ? flags[$0] : $0.slice(1, $0.length - 1);
        });
    };
};

//
// Inherit from `winston.Transport`.
//
util.inherits(DailyRotateFile, Transport);

/**
 * Define a getter so that `winston.transports.DailyRotateFile`
 * is available and thus backwards compatible.
 */
winston.transports.DailyRotateFile = DailyRotateFile;

//
// Expose the name of this Transport on the prototype
//
DailyRotateFile.prototype.name = 'dailyRotateFile';

//
// ### function log (level, msg, [meta], callback)
// #### @level {string} Level at which to log the message.
// #### @msg {string} Message to log
// #### @meta {Object} **Optional** Additional metadata to attach
// #### @callback {function} Continuation to respond to when complete.
// Core logging method exposed to Winston. Metadata is optional.
//
DailyRotateFile.prototype.log = function (level, msg, meta, callback)
{
    if (this.silent)
    {
        return callback(null, true);
    }

    //
    // If failures exceeds maxRetries then we can't access the
    // stream. In this case we need to perform a noop and return
    // an error.
    //
    if (this._failures >= this.maxRetries)
    {
        return callback(new Error('Transport is in a failed state.'));
    }

    var self = this;

    var output = common.log({
            level: level,
            message: msg,
            meta: meta,
            json: this.json,
            colorize: this.colorize,
            prettyPrint: this.prettyPrint,
            timestamp: this.timestamp,
            label: this.label,
            stringify: this.stringify,
            showLevel: this.showLevel,
            depth: this.depth,
            formatter: this.formatter,
            humanReadableUnhandledException: this.humanReadableUnhandledException
        }) + this.eol;

    this._size += output.length;

    if (this.filename)
    {
        this.open(function (err)
        {
            if (err)
            {
                //
                // If there was an error enqueue the message
                //
                return self._buffer.push([output, callback]);
            }

            self._write(output, callback);
            self._lazyDrain();
        });
    } else
    {
        //
        // If there is no `filename` on this instance then it was configured
        // with a raw `WriteableStream` instance and we should not perform any
        // size restrictions.
        //
        this._write(output, callback);
        this._lazyDrain();
    }
};

//
// ### function _write (data, cb)
// #### @data {String|Buffer} Data to write to the instance's stream.
// #### @cb {function} Continuation to respond to when complete.
// Write to the stream, ensure execution of a callback on completion.
//
DailyRotateFile.prototype._write = function (data, callback)
{
    // If this is a file write stream, we could use the builtin
    // callback functionality, however, the stream is not guaranteed
    // to be an fs.WriteStream.
    var ret = this._stream.write(data);
    if (!callback)
    {
        return;
    }

    if (ret === false)
    {
        return this._stream.once('drain', function ()
        {
            callback(null, true);
        });
    }
    callback(null, true);
};

//
// ### function query (options, callback)
// #### @options {Object} Loggly-like query options for this instance.
// #### @callback {function} Continuation to respond to when complete.
// Query the transport. Options object is optional.
//
DailyRotateFile.prototype.query = function (options, callback)
{
    if (typeof options === 'function')
    {
        callback = options;
        options = {};
    }

    // TODO when maxfilesize rotate occurs
    var file = path.join(this.dirname, this._getFilename());
    options = this.normalizeQuery(options);
    var buff = '';
    var results = [];
    var row = 0;

    var stream = fs.createReadStream(file, {
        encoding: 'utf8'
    });

    stream.on('error', function (err)
    {
        if (stream.readable)
        {
            stream.destroy();
        }
        if (!callback)
        {
            return;
        }
        return err.code === 'ENOENT' ? callback(null, results) : callback(err);
    });

    stream.on('data', function (data)
    {
        data = (buff + data).split(/\n+/);
        var l = data.length - 1;
        var i = 0;

        for (; i < l; i++)
        {
            if (!options.start || row >= options.start)
            {
                add(data[i]);
            }
            row++;
        }

        buff = data[l];
    });

    stream.on('close', function ()
    {
        if (buff)
        {
            add(buff, true);
        }
        if (options.order === 'desc')
        {
            results = results.reverse();
        }
        if (callback)
        {
            callback(null, results);
        }
    });

    function add(buff, attempt)
    {
        try
        {
            var log = JSON.parse(buff);
            if (check(log))
            {
                push(log);
            }
        } catch (e)
        {
            if (!attempt)
            {
                stream.emit('error', e);
            }
        }
    }

    function push(log)
    {
        if (options.rows && results.length >= options.rows)
        {
            if (stream.readable)
            {
                stream.destroy();
            }
            return;
        }

        if (options.fields)
        {
            var obj = {};
            options.fields.forEach(function (key)
            {
                obj[key] = log[key];
            });
            log = obj;
        }

        results.push(log);
    }

    function check(log)
    {
        if (!log)
        {
            return;
        }

        if (typeof log !== 'object')
        {
            return;
        }

        var time = new Date(log.timestamp);
        if ((options.from && time < options.from) ||
            (options.until && time > options.until))
        {
            return;
        }

        return true;
    }
};

//
// ### function stream (options)
// #### @options {Object} Stream options for this instance.
// Returns a log stream for this transport. Options object is optional.
//
DailyRotateFile.prototype.stream = function (options)
{
    var file = path.join(this.dirname, this._getFilename());
    options = options || {};
    var stream = new Stream();

    var tail = {
        file: file,
        start: options.start
    };

    stream.destroy = common.tailFile(tail, function (err, line)
    {
        if (err)
        {
            return stream.emit('error', err);
        }

        try
        {
            stream.emit('data', line);
            line = JSON.parse(line);
            stream.emit('log', line);
        } catch (e)
        {
            stream.emit('error', e);
        }
    });

    if (stream.resume)
    {
        stream.resume();
    }

    return stream;
};

//
// ### function open (callback)
// #### @callback {function} Continuation to respond to when complete
// Checks to see if a new file needs to be created based on the `maxsize`
// (if any) and the current size of the file used.
//
DailyRotateFile.prototype.open = function (callback)
{
    var now = new Date();
    if (this.opening)
    {
        //
        // If we are already attempting to open the next
        // available file then respond with a value indicating
        // that the message should be buffered.
        //
        return callback(true);
    } else if (!this._stream || (this.maxsize && this._size >= this.maxsize) || this._filenameHasExpired())
    {
        //
        // If we dont have a stream or have exceeded our size, then create
        // the next stream and respond with a value indicating that
        // the message should be buffered.
        //
        callback(true);
        return this._createStream();
    }

    //
    // Otherwise we have a valid (and ready) stream.
    //
    callback();
};

//
// ### function close ()
// Closes the stream associated with this instance.
//
DailyRotateFile.prototype.close = function ()
{
    var self = this;

    if (this._stream)
    {
        this._stream.end();
        this._stream.destroySoon();

        this._stream.once('drain', function ()
        {
            self.emit('flush');
            self.emit('closed');
        });
    }
};

//
// ### function flush ()
// Flushes any buffered messages to the current `stream`
// used by this instance.
//
DailyRotateFile.prototype.flush = function ()
{
    var self = this;

    //
    // Iterate over the `_buffer` of enqueued messaged
    // and then write them to the newly created stream.
    //
    this._buffer.forEach(function (item)
    {
        var str = item[0];
        var callback = item[1];

        process.nextTick(function ()
        {
            self._write(str, callback);
            self._size += str.length;
        });
    });

    //
    // Quickly truncate the `_buffer` once the write operations
    // have been started
    //
    self._buffer.length = 0;

    //
    // When the stream has drained we have flushed
    // our buffer.
    //
    self._stream.once('drain', function ()
    {
        self.emit('flush');
        self.emit('logged');
    });
};

//
// ### @private function _createStream ()
// Attempts to open the next appropriate file for this instance
// based on the common state (such as `maxsize` and `_basename`).
//
DailyRotateFile.prototype._createStream = function ()
{
    var self = this;
    this.opening = true;

    (function checkFile(target)
    {
        var fullname = path.join(self.dirname, target);

        //
        // Creates the `WriteStream` and then flushes any
        // buffered messages.
        //
        function createAndFlush(size)
        {
            if (self._stream)
            {
                self._stream.end();
                self._stream.destroySoon();
            }

            self._size = size;
            self.filename = target;
            self._stream = fs.createWriteStream(fullname, self.options);
            self._stream.on('error', function (error)
            {
                if (self._failures < self.maxRetries)
                {
                    self._createStream();
                    self._failures++;
                } else
                {
                    self.emit('error', error);
                }
            });

            //
            // We need to listen for drain events when
            // write() returns false. This can make node
            // mad at times.
            //
            self._stream.setMaxListeners(Infinity);

            //
            // When the current stream has finished flushing
            // then we can be sure we have finished opening
            // and thus can emit the `open` event.
            //
            self.once('flush', function ()
            {
                // Because "flush" event is based on native stream "drain" event,
                // logs could be written inbetween "self.flush()" and here
                // Therefore, we need to flush again to make sure everything is flushed
                self.flush();

                self.opening = false;
                self.emit('open', fullname);
            });

            //
            // Remark: It is possible that in the time it has taken to find the
            // next logfile to be written more data than `maxsize` has been buffered,
            // but for sensible limits (10s - 100s of MB) this seems unlikely in less
            // than one second.
            //
            self.flush();
            if (self.zippedArchive && self._archive != fullname)
            {
                if (self._archive !== false)
                {
                    createArchive(self._archive);
                }
                self._archive = fullname;
            }
        }

        function createArchive(fileToZip)
        {
            var gzip = zlib.createGzip();
            var inp = fs.createReadStream(fileToZip);
            var out = fs.createWriteStream(fileToZip + '.gz');
            inp.pipe(gzip).pipe(out);
            fs.unlink(fileToZip)
        }

        fs.stat(fullname, function (err, stats)
        {
            if (err)
            {
                if (err.code !== 'ENOENT')
                {
                    return self.emit('error', err);
                }

                return createAndFlush(0);
            }

            if (!stats || (self.maxsize && stats.size >= self.maxsize))
            {
                //
                // If `stats.size` is greater than the `maxsize` for
                // this instance then try again
                //
                return checkFile(self._getFile(true));
            }

            if (self._filenameHasExpired())
            {
                var now = new Date();
                self._year = now.getFullYear();
                self._month = now.getMonth();
                self._date = now.getDate();
                self._hour = now.getHours();
                self._minute = now.getMinutes();
                self._created = 0;
                return checkFile(self._getFile());
            }

            createAndFlush(stats.size);
        });
    })(this._getFile());
};

//
// ### @private function _getFile ()
// Gets the next filename to use for this instance
// in the case that log filesizes are being capped.
//
DailyRotateFile.prototype._getFile = function (inc)
{
    var filename = this._getFilename();
    var remaining;

    if (inc)
    {
        //
        // Increment the number of files created or
        // checked by this instance.
        //
        // Check for maxFiles option and delete file
        this._unlinkOldFiles();
        this._created += 1;
    }

    return this._created ? filename + '.' + this._created : filename;
};

//
// ### @private function _getFilename ()
// Returns the log filename depending on `this.prepend` option value
//
DailyRotateFile.prototype._getFilename = function ()
{
    var formattedDate = this.getFormattedDate();

    if (this.prepend)
    {
        if (this.datePattern === '.yyyy-MM-dd')
        {
            this.datePattern = 'yyyy-MM-dd.';
            formattedDate = this.getFormattedDate();
        }

        return formattedDate + this._basename;
    }

    return this._basename + formattedDate;
};

//
// ### @private function _lazyDrain ()
// Lazily attempts to emit the `logged` event when `this.stream` has
// drained. This is really just a simple mutex that only works because
// Node.js is single-threaded.
//
DailyRotateFile.prototype._lazyDrain = function ()
{
    var self = this;

    if (!this._draining && this._stream)
    {
        this._draining = true;

        this._stream.once('drain', function ()
        {
            this._draining = false;
            self.emit('logged');
        });
    }
};

//
// ### @private function _filenameHasExpired ()
// Checks whether the current log file is valid
// based on given datepattern
//
DailyRotateFile.prototype._filenameHasExpired = function ()
{
    var now = new Date();
    var self = this;
    var ret = false;
    this.datePattern.replace(this._token, function ($0)
    {
        if ($0 === 'yy' || $0 === 'yyyy')
        {
            ret |= self._year !== now.getFullYear();
        } else if ($0 === 'M' || $0 === 'MM')
        {
            ret |= self._month !== now.getMonth();
        } else if ($0 === 'd' || $0 === 'dd')
        {
            ret |= self._date !== now.getDate();
        } else if ($0 === 'H' || $0 === 'HH')
        {
            ret |= self._hour !== now.getHours();
        } else if ($0 === 'm' || $0 === 'mm')
        {
            ret |= self._minute !== now.getMinutes();
        }
    });

    return ret === 1;
};


DailyRotateFile.prototype._unlinkOldFiles = function ()
{
    var self = this;
    if (this.maxFiles || this.olderThan)
    {
        fs.readdir(this.dirname, function (err, files)
        {
            if (err)
            {
                this.emit('error', err);
            } else
            {
                var fileNames = [];
                for (var i = 0; i < files.length; i++)
                {
                    var file = files[i]
                    if (file.indexOf(self._basename) == 0 && (self.zippedArchive == false || (self.zippedArchive && file.lastIndexOf('.gz') == file.length - 3)))
                    {
                        fileNames.push(path.join(self.dirname, file));
                    }
                }

                async.map(fileNames, function (fileName, cb)
                {
                    fs.stat(fileName, function (err, stat)
                    {
                        if (err)
                        {
                            return cb(err);
                        }

                        cb(null, {
                            name: fileName,
                            isFile: stat.isFile(),
                            time: stat.mtime
                        });
                    });
                }, function (err, selectedFiles)
                {
                    if (err)
                    {
                        return self.emit('error', err);
                    }

                    selectedFiles = selectedFiles.filter(function (file)
                    {
                        return file.isFile;
                    });

                    if (self.maxFiles)
                    {

                        selectedFiles.sort(function (filea, fileb)
                        {
                            return filea.time > fileb.time;
                        });

                        if (selectedFiles.length >= self.maxFiles - (self.zippedArchive ? 1 : 0))
                        {
                            var deleteCount = selectedFiles.length - self.maxFiles + (self.zippedArchive ? 2 : 1);
                            selectedFiles = selectedFiles.slice(0, deleteCount);

                            async.map(selectedFiles, function (file, cb)
                            {
                                fs.unlink(file.name);
                                cb();
                            }, function (err, removedFiles)
                            {

                            });
                        }
                    } else if (self.olderThan)
                    {
                        var now = Date.now() - ms(self.olderThan);
                        selectedFiles = selectedFiles.filter(function (file)
                        {
                            return file.time <= now;
                        });

                        async.map(selectedFiles, function (file, cb)
                        {
                            fs.unlink(file.name);
                            cb();
                        }, function (err, removedFiles)
                        {

                        });
                    }

                });
            }
        });
    }
};