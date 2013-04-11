/***********************************************************************
* retro-b5500/emulator B5500DiskUnit.js
************************************************************************
* Copyright (c) 2013, Nigel Williams and Paul Kimpel.
* Licensed under the MIT License, see
*       http://www.opensource.org/licenses/mit-license.php
************************************************************************
* B5500 Disk File Control Unit module.
*
* Defines a peripheral unit type for the Disk File Control Unit used with
* Burroughs Model I and Model IB Head-per-Track disk units. The DFCU is the
* addressable unit to the B5500. This module manages the Electronic Units (EU)
* and Storage Units (SU) that make up the physical disk storage facility.
*
* Physical storage in this implementation is provided by a W3C IndexedDB
* database local to the browser in which the emulator is running. This database
* must have been previously initialized; see tools/B5500ColdLoader.html.
*
* The database consists of a CONFIG object store and some number of EUn object
* stores, where n is in 0..9. The CONFIG store contains an "eus" member that
* specifies the total number of EU objects, plus an "EUn" member that specicies
* the size of that EU in 240-character segments. There may be gaps in the EU
* numbering.
*
* Within an EU, segments are represented in the database as 240-byte Uint8Array
* objects, each with a database key corresponding to its numeric segment address.
* The segments are an EU are not pre-allocated, but are created as they are
* written to by IDB put() methods. When reading, any unallocated segments are
* returned with their bytes set to binary zero, which will be translated to
* BIC "?" by the IOU for both binary and alpha modes.
*
* At present, disk write lockout is not supported. When there are two DFCUs in
* the system, the presence of a Disk File Exchange is assumed, allowing either
* DFCU to access any EU. Thus this implementation is currently limited to a
* maximum of 10 EUs (480 million characters).
*
* Note that all disk I/O is done in units of 240-character segments. The
* interface with the I/O Unit uses lengths in terms of characters, however.
* All lengths SHOULD be multiples of 240 characters; any other values will be
* rounded up to the next multiple of 240. The I/O Unit is responsible for any
* padding or truncation to account for differences between the segment count
* and word count in the IOD. This implementation ignores binary vs. alpha mode
* and assumes the IOU does any necessary translation.
*
* The starting disk segment address for an I/O is passed in the "control"
* parameter to each of the I/O methods. This is an an alphanumeric value in
* the B5500 memory and I/O Unit. The I/O unit translates this value to binary
* for the "control" parameter. The low-order six decimal digits of the value
* comprise the segment address within the EU. The seventh decimal digit is the
* EU number. Any other portion of the value is ignored.
*
* The DFCU's "read check" operation is asynchronous with respect to the IOU, and
* the I/O operation itself completes almost immediately. Because of this, any
* error reporting for the read check is deferred until the next I/O operation
* (typically an interrogate) against the unit. Therefore, the error mask is
* cleared at the end of each disk I/O operation (except for read check) instead
* of at the beginning, and new  errors are OR-ed with any errors persisting from
* the prior operation.
*
* This module attempts to simulate actual disk activity times by delaying the
* finish() call by an amount of time computed from the numbers of sectors
* requested and the Model I SU's average 96KC transfer rate, plus a random
* distribution across its 40ms max rotational latency time.
************************************************************************
* 2013-01-19  P.Kimpel
*   Original version, cloned from B5500DummyUnit.js.
***********************************************************************/
"use strict";

/**************************************/
function B5500DiskUnit(mnemonic, index, designate, statusChange, signal) {
    /* Constructor for the DiskUnit object */

    this.mnemonic = mnemonic;           // Unit mnemonic
    this.index = index;                 // Ready-mask bit number
    this.designate = designate;         // IOD unit designate number
    this.statusChange = statusChange;   // external function to call for ready-status change
    this.signal = signal;               // external function to call for special signals (e.g,. SPO input request)

    this.clear();
}

B5500DiskUnit.prototype.dbName = "B5500DiskUnit";    // IndexedDB database name
B5500DiskUnit.prototype.dbVersion = 1;               // current IDB database version
B5500DiskUnit.prototype.configName = "CONFIG";       // database configuration store name
B5500DiskUnit.prototype.euPrefix = "EU";             // prefix for EU object store names
B5500DiskUnit.prototype.charXferRate = 96000;        // avg. transfer rate, characters/sec (Model I SU)
B5500DiskUnit.prototype.maxLatency = 0.040;          // max rotational latency, sec (Model I SU)

/**************************************/
B5500DiskUnit.prototype.clear = function() {
    /* Initializes (and if necessary, creates) the processor state */

    this.ready = false;                 // ready status
    this.busy = false;                  // busy status
    this.activeIOUnit = 0;              // I/O unit currently using this device

    this.errorMask = 0;                 // error mask for finish()
    this.finish = null;                 // external function to call for I/O completion
    this.startStamp = null;             // I/O starting timestamp

    this.config = null;                 // copy of CONFIG store contents
    this.disk = null;                   // the IDB database object

    this.openDatabase();                // attempt to open the IDB database
};

/**************************************/
B5500DiskUnit.genericDBError = function(ev) {
    /* Formats a generic alert when otherwise-unhandled database errors occur */
    var disk = ev.currentTarget.result;

    this.errorMask |= 0x20;             // set a generic disk-parity error
    alert("Database for \"" + this.mnemonic + "\" error: " + ev.target.result.error);
    this.finish(this.errorMask, 0);
    this.errorMask = 0;
};

/**************************************/
B5500DiskUnit.prototype.copySegment = function(seg, buffer, offset) {
    /* Copies the bytes from a single segment Uint8Array object to "buffer" starting
    at "offset" for 240 bytes. If "seg" is undefined, copies zero bytes instead */
    var x;

    if (seg) {
        for (x=0; x<240; x++) {
            buffer[offset+x] = seg[x];
        }
    } else {
        for (x=offset+239; x>=offset; x--) {
            buffer[x] = 0x23;           // ASCII "#", translates as alpha to BIC "0" = @00
        }
    }
};

/**************************************/
B5500DiskUnit.prototype.openDatabase = function() {
    /* Attempts to open the disk subsystem database specified by this.dbName and
    this.dbVersion. If successful, sets this.disk to the IDB object and sets the
    DFCU to ready status */
    var req;
    var db = null;
    var that = this;

    that.statusChange(0);               // initially force DFCU status to not ready
    req = window.indexedDB.open(that.dbName, that.dbVersion);

    req.onerror = function(ev) {
        alert("Cannot open " + that.mnemonic + " database: " + ev.target.error);
    };

    req.onblocked = function(ev) {
        alert("Database.open is blocked -- cannot continue");
    };

    req.onupgradeneeded = function(ev) {
        alert("Database requires version upgrade -- cannot continue");
    };

    req.onsuccess = function(ev) {
        that.disk = ev.target.result;    // save the object reference globally for later use
        that.disk.onerror = function(ev) {
            alert("Database for \"" + this.mnemonic + "\" open error: " + ev.target.result.error);
        };

        that.disk.transaction("CONFIG").objectStore("CONFIG").get(0).onsuccess = function(ev) {
            that.config = ev.target.result;
            that.statusChange(1);       // report the DFCU as ready to Central Control
            // Set up the generic error handler
            that.disk.onerror = function(ev) {
                that.genericIDBError(ev);
            };
        };
    };
};

/**************************************/
B5500DiskUnit.prototype.read = function(finish, buffer, length, mode, control) {
    /* Initiates a read operation on the unit. "length" is in characters; segment address
    is in "control". "mode" is ignored (any translation would have been done by IOU) */
    var bx = 0;                         // current buffer offset
    var euSize;                         // max seg size for EU
    var finishTime;                     // predicted time of I/O completion, ms
    var range;                          // key range for multi-segment read
    var req;                            // IDB request object
    var that = this;                    // local object context
    var txn;                            // IDB transaction object

    this.finish = finish;               // for global error handler
    var segs = Math.floor((length+239)/240);
    var segAddr = control % 1000000;    // starting seg address
    var euNumber = (control % 10000000 - segAddr)/1000000;
    var euName = this.euPrefix + euNumber;
    var endAddr = segAddr+segs-1;       // ending seg address

    euSize = this.config[euName];
    if (!euSize) {                      // EU does not exist
        finish(this.errorMask | 0x20, 0);       // set D27F for EU not ready
        this.errorMask = 0;
    } else if (segAddr < 0) {
        finish(this.errorMask | 0x20, 0);       // set D27F for invalid starting seg address
        this.errorMask = 0;
    } else {
        if (endAddr >= euSize) {        // if read is past end of disk
            this.errorMask |= 0x20;     // set D27F for invalid seg address
            segs = euSize-segAddr;      // compute number of segs possible to read
            length = segs*240;          // recompute length and ending seg address
            endAddr = euSize-1;
        }
        finishTime = new Date().getTime() +
                (Math.random()*this.maxLatency + segs*240/this.charXferRate)*1000;

        if (segs < 1) {                 // No length specified, so just finish the I/O
            finish(this.errorMask, 0);
            this.errorMask = 0;
        } else if (segs < 2) {          // A single-segment read
            req = this.disk.transaction(euName).objectStore(euName).get(segAddr);
            req.onsuccess = function(ev) {
                that.copySegment(ev.target.result, buffer, 0);
                setTimeout(function() {
                    finish(that.errorMask, length);
                    that.errorMask = 0;
                }, finishTime - new Date().getTime());
            }
        } else {                        // A multi-segment read
            range = window.IDBKeyRange.bound(segAddr, endAddr);
            txn = this.disk.transaction(euName);

            req = txn.objectStore(euName).openCursor(range);
            req.onsuccess = function(ev) {
                var cursor = ev.target.result;

                if (cursor) {           // found a segment at some address in range
                    // fill buffer with zeroes for any unallocated segments
                    while (cursor.key > segAddr) {
                        that.copySegment(null, buffer, bx);
                        bx += 240;
                        segAddr++;
                    }
                    // copy the segment data to the buffer and request next seg
                    that.copySegment(cursor.value, buffer, bx);
                    bx += 240;
                    segAddr++;
                    cursor.continue();
                } else {                // at end of range
                    // fill buffer with zeroes for any remaining segments in range
                    while (endAddr > segAddr) {
                        that.copySegment(null, buffer, bx);
                        bx += 240;
                        segAddr++;
                    }
                    setTimeout(function() {
                        finish(that.errorMask, length);
                        that.errorMask = 0;
                    }, finishTime - new Date().getTime());
                }
            };
        }
    }
};

/**************************************/
B5500DiskUnit.prototype.space = function(finish, length, control) {
    /* Initiates a space operation on the unit */

    finish(0x04, 0);                    // report unit not ready
};

/**************************************/
B5500DiskUnit.prototype.write = function(finish, buffer, length, mode, control) {
    /* Initiates a write operation on the unit. "length" is in characters; segment address
    is in "control". "mode" is ignored (any translation will done by the IOU) */
    var bx = 0;                         // current buffer offset
    var eu;                             // IDB object store for EU
    var euSize;                         // max seg size for EU
    var finishTime;                     // predicted time of I/O completion, ms
    var req;                            // IDB request object
    var that = this;                    // local object context
    var txn;                            // IDB transaction object

    this.finish = finish;               // for global error handler
    var segs = Math.floor((length+239)/240);
    var segAddr = control % 1000000;    // starting seg address
    var euNumber = (control % 10000000 - segAddr)/1000000;
    var euName = this.euPrefix + euNumber;
    var endAddr = segAddr+segs-1;       // ending seg address

    euSize = this.config[euName];
    if (!euSize) {                      // EU does not exist
        finish(this.errorMask | 0x20, 0);       // set D27F for EU not ready
        this.errorMask = 0;
    } else if (segAddr < 0) {
        finish(this.errorMask | 0x20, 0);       // set D27F for invalid starting seg address
        this.errorMask = 0;
    } else {
        if (endAddr >= euSize) {        // if read is past end of disk
            this.errorMask |= 0x20;     // set D27F for invalid seg address
            segs = euSize-segAddr;      // compute number of segs possible to read
            length = segs*240;          // recompute length and ending seg address
            endAddr = euSize-1;
        }
        finishTime = new Date().getTime() +
                (Math.random()*this.maxLatency + segs*240/this.charXferRate)*1000;

        // No length specified, so just finish the I/O
        if (segs < 1) {
            finish(this.errorMask, 0);
            this.errorMask = 0;

        // Do the write
        } else {
            txn = this.disk.transaction(euName, "readwrite")
            txn.oncomplete = function(ev) {
                setTimeout(function() {
                    finish(that.errorMask, length);
                    that.errorMask = 0;
                }, finishTime - new Date().getTime());
            };
            eu = txn.objectStore(euName);
            for (; segAddr<=endAddr; segAddr++) {
                eu.put(buffer.subarray(bx, bx+240), segAddr);
                bx += 240;
            }
        }
    }
};

/**************************************/
B5500DiskUnit.prototype.erase = function(finish, length) {
    /* Initiates an erase operation on the unit */

    finish(0x04, 0);                    // report unit not ready
};

/**************************************/
B5500DiskUnit.prototype.rewind = function(finish) {
    /* Initiates a rewind operation on the unit */

    finish(0x04, 0);                    // report unit not ready
};

/**************************************/
B5500DiskUnit.prototype.readCheck = function(finish, length, control) {
    /* Initiates a read check operation on the unit. "length" is in characters;
    segment address is in "control". "mode" is ignored. This is essentially a
    read without any data transfer to memory. Note that the errorMask is NOT
    zeroed at the end of the I/O -- it will be reported with the next I/O */
    var euSize;                         // max seg size for EU
    var finishTime;                     // predicted time of I/O completion, ms
    var range;                          // key range for multi-segment read
    var req;                            // IDB request object
    var that = this;                    // local object context
    var txn;                            // IDB transaction object

    this.finish = finish;               // for global error handler
    var segs = Math.floor((length+239)/240);
    var segAddr = control % 1000000;    // starting seg address
    var euNumber = (control % 10000000 - segAddr)/1000000;
    var euName = this.euPrefix + euNumber;
    var endAddr = segAddr+segs-1;       // ending seg address

    this.errorMask = 0;                 // clear any prior error mask
    euSize = this.config[euName];
    if (!euSize) {                      // EU does not exist
        finish(this.errorMask | 0x20, 0);       // set D27F for EU not ready
        this.signal();
        // DO NOT clear the error mask
    } else if (segAddr < 0) {
        finish(this.errorMask | 0x20, 0);       // set D27F for invalid starting seg address
        this.signal();
        // DO NOT clear the error mask
    } else {
        if (endAddr >= euSize) {        // if read is past end of disk
            this.errorMask |= 0x20;     // set D27F for invalid seg address
            segs = euSize-segAddr;      // compute number of segs possible to read
            length = segs*240;          // recompute length and ending seg address
            endAddr = euSize-1;
        }
        finishTime = new Date().getTime() +
                (Math.random()*this.maxLatency + segs*240/this.charXferRate)*1000;

        if (segs < 1) {                 // No length specified, so just finish the I/O
            finish(this.errorMask, 0);
            this.signal();
            // DO NOT clear the error mask -- will return it on the next interrogate
        } else {                        // A multi-segment read
            range = window.IDBKeyRange.bound(segAddr, endAddr);
            txn = this.disk.transaction(euName);
            finish(that.errorMask, length);     // post I/O complete now -- DFCU will signal when check finished

            req = txn.objectStore(euName).openCursor(range);
            req.onsuccess = function(ev) {
                var cursor = ev.target.result;

                if (cursor) {           // found a segment at some address in range
                    cursor.continue();
                } else {                // at end of range
                    setTimeout(function() {
                        that.signal();
                        // DO NOT clear the error mask
                    }, finishTime - new Date().getTime());
                }
            };
        }
    }
};

/**************************************/
B5500DiskUnit.prototype.readInterrogate = function(finish, control) {
    /* Initiates a read interrogate operation on the unit. This serves only to
    check the addresss for validity and to return any errorMask from a prior
    read check operation. This implementation assumes completion will be delayed
    by a random amount of time based on rotational latency for the EU to search for
    the address */
    var euSize;                         // max seg size for EU
    var segAddr = control % 1000000;    // starting seg address
    var euNumber = (control % 10000000 - segAddr)/1000000;
    var euName = this.euPrefix + euNumber;
    var that = this;

    this.finish = finish;               // for global error handler
    euSize = this.config[euName];
    if (!euSize) {                      // EU does not exist
        finish(this.errorMask | 0x20, 0);       // set D27F for EU not ready
        this.errorMask = 0;
    } else {
        if (segAddr < 0 || segAddr >= euSize) { // if read is past end of disk
            this.errorMask |= 0x20;     // set D27F for invalid seg address
        }
        setTimeout(function() {
            finish(that.errorMask, length);
            that.errorMask = 0;
        }, Math.random()*this.maxLatency*1000);
    }
};

/**************************************/
B5500DiskUnit.prototype.writeInterrogate = function (finish, control) {
    /* Initiates a write interrogate operation on the unit. This serves only to
    check the addresss for validity and to return any errorMask from a prior
    read check operation. This implementation assumes completion will be delayed
    by a random amount of time based on rotational latency for the EU to search for
    the address */

    /* Note: until disk write lockout is implemented, this operation is identical
    to readInterrogate() */

    var euSize;                         // max seg size for EU
    var segAddr = control % 1000000;    // starting seg address
    var euNumber = (control % 10000000 - segAddr)/1000000;
    var euName = this.euPrefix + euNumber;
    var that = this;

    this.finish = finish;               // for global error handler
    euSize = this.config[euName];
    if (!euSize) {                      // EU does not exist
        finish(this.errorMask | 0x20, 0);       // set D27F for EU not ready
        this.errorMask = 0;
    } else {
        if (segAddr < 0 || segAddr >= euSize) { // if read is past end of disk
            this.errorMask |= 0x20;     // set D27F for invalid seg address
        }
        setTimeout(function() {
            finish(that.errorMask, length);
            that.errorMask = 0;
        }, Math.random()*this.maxLatency*1000);
    }
};
