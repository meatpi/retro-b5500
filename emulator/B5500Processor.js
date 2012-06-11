/***********************************************************************
* retro-b5500/emulator B5500Processor.js
************************************************************************
* Copyright (c) 2012, Nigel Williams and Paul Kimpel.
* Licensed under the MIT License, see http://www.opensource.org/licenses/mit-license.php
************************************************************************
* JavaScript object definition for the B5500 Processor (CPU) module.
************************************************************************
* 2012-06-03  P.Kimpel
*   Original version, from thin air.
***********************************************************************/

/**************************************/
function B5500Processor() {
    /* Constructor for the Processor module object */

    this.timeSlice = 5000;              // Standard run() timeslice, about 5ms (we hope)

    this.scheduler = null;              // Reference to current setTimeout id
    this.accessor = {                   // Memory access control block
        addr: 0,                           // Memory address
        word: 0,                           // 48-bit data word
        MAIL: 0,                           // Truthy if attempt to access @000-@777 in normal state
        MPED: 0,                           // Truthy if memory parity error
        MAED: 0};                          // Truthy if memory address/inhibit error

    this.clear();                       // Create and initialize the processor state
}

/**************************************/
B5500Processor.prototype.clear = function() {
    /* Initializes the processor state */

    this.A = 0;                         // Top-of-stack register 1
    this.AROF = 0;                      // A contents valid
    this.B = 0;                         // Top-of-stack register 2
    this.BROF = 0;                      // B contents valid
    this.C = 0;                         // Current program instruction word address
    this.CCCF = 0;                      // Clock-count control FF (maintenance only)
    this.CWMF = 0;                      // Character/word mode FF (1=CM)
    this.E = 0;                         // Memory access control register
    this.EIHF = 0;                      // ??
    this.F = 0;                         // Top MSCW/RCW stack address
    this.G = 0;                         // Character index register for A
    this.H = 0;                         // Bit index register for G (in A)
    this.HLTF = 0;                      // Processor halt FF
    this.I = 0;                         // Processor interrupt register
    this.K = 0;                         // Character index register for B
    this.L = 0;                         // Instruction syllable index in P
    this.M = 0;                         // Memory address register (SI.w in CM)
    this.MRAF = 0;                      // Memory read access FF
    this.MROF = 0;                      // Memory read obtained FF
    this.MSFF = 0;                      // Mark-stack FF (word mode: MSCW is pending RCW, physically also TFFF & Q12F)
    this.MWOF = 0;                      // Memory write obtained FF
    this.N = 0;                         // Octal shift counter for B
    this.NCSF = 0;                      // Normal/control state FF (1=normal)
    this.P = 0;                         // Current program instruction word register
    this.PROF = 0;                      // P contents valid
    this.Q = 0;                         // Misc. FFs (bits 1-9 only: Q07F=hardware-induced interrupt, Q09F=enable parallel adder for R-relative addressing)
    this.R = 0;                         // PRT base address (low-order 6 bits are always zero in word mode)
    this.S = 0;                         // Top-of-stack memory address (DI.w in CM)
    this.SALF = 0;                      // Program/subroutine state FF (1=subroutine)
    this.T = 0;                         // Current program syllable register
    this.TM = 0;                        // Temporary maintenance storage register
    this.TROF = 0;                      // T contents valid
    this.V = 0;                         // Bit index register for K (in B)
    this.VARF = 0;                      // Variant-mode FF (enables full PRT indexing)
    this.X = 0;                         // Mantissa extension for B (loop control in CM)
    this.Y = 0;                         // Serial character register for A
    this.Z = 0;                         // Serial character register for B

    this.cycleCount = 0;                // Current cycle count for this.run()
    this.cycleLimit = 0;                // Cycle limit for this.run()
    this.totalCycles = 0;               // Total cycles executed on this processor
    this.procTime = 0;                  // Current processor running time, based on cycles executed
    this.scheduleSlack = 0;             // Total processor throttling delay, milliseconds
    this.busy = false;                  // Proessor is running, not idle or halted
}

/**************************************/
B5500Processor.prototype.access = function(eValue) {
    /* Access memory based on the E register. If the processor is in normal
    state, it cannot access the first 512 words of memory => invalid address */

    this.E = eValue;                    // Just to show the world what's happening
    this.accessor.MAIL = (addr < 0x0200 && this.NCSF);
    switch (eValue) {
    case 0x02:                          // A = [S]
        this.accessor.addr = this.S;
        cc.fetch(this);
        this.A = this.accessor.word;
        this.AROF = 1;
        break;
    case 0x03:                          // B = [S]
        this.accessor.addr = this.S;
        cc.fetch(this);
        this.B = this.accessor.word;
        this.BROF = 1;
        break;
    case 0x04:                          // A = [M]
        this.accessor.addr = this.M;
        cc.fetch(this);
        this.A = this.accessor.word;
        this.AROF = 1;
        break;
    case 0x05:                          // B = [M]
        this.accessor.addr = this.M;
        cc.fetch(this);
        this.B = this.accessor.word;
        this.BROF = 1;
        break;
    case 0x06:                          // M = [M].[18:15]
        this.accessor.addr = this.M;
        cc.fetch(this);
        this.M = (this.accessor.word >>> 15) & 0x7FFF;
        break;
    case 0x0A:                          // [S] = A
        this.accessor.addr = this.S;
        this.accessor.word = this.A;
        cc.store(this);
        break;
    case 0x0B:                          // [S] = B
        this.accessor.addr = this.S;
        this.accessor.word = this.B;
        cc.store(this);
        break;
    case 0x0C:                          // [M] = A
        this.accessor.addr = this.M;
        this.accessor.word = this.A;
        cc.store(this);
        break;
    case 0x0D:                          // [M] = B
        this.accessor.addr = this.M;
        this.accessor.word = this.B;
        cc.store(this);
        break;
    case 0x30:                          // P = [C]
        this.accessor.addr = this.C;
        cc.fetch(this);
        this.P = this.accessor.word;
        this.PROF = 1;
        break;
    default:
        throw "Invalid E register value: " + eReg.toString(2);
        break;
    }

    this.cycleCount += 6;               // assume 6 us memory cycle time
    if (this.accessor.MAED) {
        this.I |= 0x02;                 // set I02F - memory address/inhibit error
        if (this.NCSF || this !== cc.P1) {
            cc.signalInterrupt();
        } else {
            this.busy = false;          // P1 invalid address in control state stops the proc
        }
    } else if (this.accessor.MPED) {
        this.I |= 0x01;                 // set I01F - memory parity error
        if (this.NCSF || this !== cc.P1) {
            cc.signalInterrupt();
        } else {
            this.busy = false;          // P1 memory parity in control state stops the proc
        }
    }
}

/**************************************/
B5500Processor.prototype.adjustAEmpty = function() {
    /* Adjusts the A register so that it is empty pushing the prior
    contents of A into B and B into memory, as necessary. */

    if (this.AROF} {
        if (this.BROF) {
            if (this.S < this.R || !this.NCSF) {
                this.S++;
                this.access(0x0B);      // [S] = B
            } else {
                this.I |= 0x04;         // set I03F: stack overflow
                cc.signalInterrupt();
            }
        }
        this.B = this.A;
        this.AROF = 0;
        this.BROF = 1;
    // else we're done -- A is already empty
    }
}

/**************************************/
B5500Processor.prototype.adjustAFull = function() {
    /* Adjusts the A register so that it is full, popping the contents of
    B or [S] into A, as necessary. */

    if (!this.AROF) {
        if (this.BROF) {
            this.A = this.B;
            this.AROF = 1;
            this.BROF = 0;
        } else {
            this.access(0x02);          // A = [S]
            this.S--;
        }
    // else we're done -- A is already full
    }
}

/**************************************/
B5500Processor.prototype.adjustBEmpty = function() {
    /* Adjusts the B register so that it is empty pushing the prior
    contents of B into memory, as necessary. */

    if (this.BROF) {
        if (this.S < this.R || !this.NCSF) {
            this.S++;
            this.access(0x0B);          // [S] = B
        } else {
            this.I |= 0x04;             // set I03F: stack overflow
            cc.signalInterrupt();
        }
    // else we're done -- B is already empty
    }
}

/**************************************/
B5500Processor.prototype.adjustBFull = function() {
    /* Adjusts the B register so that it is full popping the contents of
    [S] into B, as necessary. */

    if (!this.BROF) {
        this.access(0x03);              // B = [S]
        this.S--;
    // else we're done -- B is already full
    }
}

/**************************************/
B5500Processor.storeForInterrupt = function(forTest) {
    /* Implements the 3011=SFI operator and the parts of SFT that are
    common to it. "forTest" implies use from SFT */
    var forced = this.Q & 0x0040;       // Q07F: Hardware-induced SFI syllable
    var saveAROF = this.AROF;
    var saveBROF = this.BROF;
    var temp;

    if (forced || forTest) {
        this.NCSF = 0;                  // switch to control state
    }

    if (this.CWMF) {
        temp = this.S;                  // get the correct TOS address from X
        this.S = (this.X % 0x40000000) >>> 15;
        this.X = this.X % 0x8000 +
              temp * 0x8000 +
              Math.floor(this.X / 0x40000000) * 0x40000000;
        if (this.AROF || forTest) {
            this.access(0x0A);          // [S] = A
        }
        if (this.BROF || forTest) {
            this.access(0x0B);          // [S] = B
        }
        this.B = this.X +               // store CM loop-control word
              saveAROF * 0x200000000000 +
              0xC00000000000;
        this.access(0x0B);              // [S] = B
    } else {
        if (this.BROF || forTest) {
            this.access(0x0B);          // [S] = B
        }
        if (this.AROF || forTest) {
            this.access(0x0A);          // [S] = A
        }
    }
    this.B = this.M +                   // store interrupt control word (ICW)
          this.N * 0x8000 +
          this.VARF * 0x1000000 +
          this.SALF * 0x40000000 +
          this.MSFF * 0x80000000 +
          (this.CWMF ? this.R : this.R >>> 6) * 0x200000000 +
          0xC00000000000;
    this.access(0x0B);                  // [S] = B

    this.B = this.C +                   // store interrupt return control word (IRCW)
          this.F * 0x8000 +
          this.K * 0x40000000 +
          this.G * 0x200000000 +
          this.L * 0x1000000000 +
          this.V * 0x4000000000 +
          this.H * 0x20000000000 +
          saveBROF * 0x200000000000 +
          0xC00000000000;
    this.access(0x0B);                  // [S] = B

    if (this.CWMF) {
        temp = this.F;                  // if CM, get correct R value from last MSCW
        this.F = this.S;
        this.S = temp;
        this.access(0x03);              // B = [S]: get last RCW
        this.S = ((this.B % 0x40000000) >>> 15) & 0x7FFF;
        this.access(0x03);              // B = [S]: get last MSCW
        this.R = (Math.Floor(this.B / 0x200000000) % 0x200) << 6;
        this.S = this.F;
    }

    this.B = this.S +                   // store the initiate control word (INCW)
          this.CWMF * 0x8000 +
          0xC00000000000;
    if (forTest) {
        this.B += (this.TM & 0x1F) * 0x10000 +
               this.Z * 0x400000 +
               this.Y * 0x10000000 +
               (this.Q & 0x1FF) * 0x400000000;
        this.TM = 0;
        this.MROF = 0;
        this.MWOF = 0;
   }

    this.M = this.R + 0x08;             // store initiate word at R+@10
    this.access(0x0D);                  // [M] = B

    this.M = 0;
    this.R = 0;
    this.MSFF = 0;
    this.SALF = 0;
    this.BROF = 0;
    this.AROF = 0;
    if (forced) {
        if (this === cc.P1) {
            this.T = 0x89;              // inject 0211=ITI into T register
        } else {
            this.T = 0;                 // idle the processor
            this.TROF = 0;
            this.PROF = 0;
            cc.HP2F = 1;
            cc.P2BF = 0;
            this.busy = false;
        }
        this.CWMF = 0;
    } else if (forTest) {
        this.CWMF = 0;
        if (this === cc.P1) {
            this.access(0x05);          // B = [M]: load DD for test
            this.C = this.B % 0x7FFF;
            this.L = 0;
            this.access(0x30);          // P = [C]: first word of test routine
            this.G = 0;
            this.H = 0;
            this.K = 0;
            this.V = 0;
        } else {
            this.T = 0;                 // idle the processor
            this.TROF = 0;
            this.PROF = 0;
            cc.HP2F = 1;
            cc.P2BF = 0;
            this.busy = false;
        }
    }
}

/**************************************/
B5500Processor.initiate = function(forTest) {
    /* Initiates the processor from interrupt control words stored in the
    stack. Assumes the INCW is in A. "forTest" implies use from IFT */
    var saveAROF;
    var saveBROF;
    var temp;

    // restore the Initiate Control Word or Initiate Test Control Word
    this.S = this.A % 0x8000;
    this.CWMF = Math.floor(this.A / 0x8000) % 0x02;
    if (forTest) {
        this.TM = Math.floor(this.A / 0x10000) % 0x20;
        this.Z = Math.floor(this.A / 0x400000) % 0x40;
        this.Y = Math.floor(this.A / 0x10000000) % 0x40;
        this.Q = Math.floor(this.A / 0x400000000) % 0x200;
        this.TM |= Math.floor(this.A / 0x200000( % 0x02 << 5;           // CCCF
        this.TM |= Math.floor(this.A / 0x80000000000) % 0x02 << 6;      // MWOF
        this.TM |= Math.floor(this.A / 0x400000000000) % 0x02 << 7;     // MROF
        // Emulator doesn't support J register, so can't set that from TM
    }
    this.AROF = 0;
    this.BROF = 0;

    // restore the Interrupt Return Control Word
    this.access(0x03);                  // B = [S]
    this.S--;
    this.C = this.B % 0x8000;
    this.F = Math.floor(this.B / 0x8000) % 0x8000;
    this.K = Math.floor(this.B / 0x40000000) % 0x08;
    this.G = Math.floor(this.B / 0x200000000) % 0x08;
    this.L = Math.floor(this.B / 0x1000000000) % 0x04;
    this.V = Math.floor(this.B / 0x4000000000) % 0x08;
    this.H = Math.floor(this.B / 0x20000000000) % 0x08;
    this.access(0x30);                  // P = [C]
    if (this.CWMF || forTest) {
        saveBROF = Math.floor(this.B / 200000000000) % 0x02;
    }

    // restore the Interrupt Control Word
    this.access(0x03);                  // B = [S]
    this.S--;
    this.VARF = Math.floor(this.B / 0x1000000) % 0x02;
    this.SALF = Math.floor(this.B / 0x40000000) % 0x02;
    this.MSFF = Math.floor(this.B / 0x80000000) % 0x02;
    temp = (Math.floor(this.B / 0x200000000) % 0x200);
    this.R = (this.CWMF ? temp & 0x3F : temp << 6);

    if (this.CWMF || forTest) {
        this.M = this.B % 0x8000;
        this.N = Math.floor(this.B / 0x8000) % 0x10;

        // restore the CM Interrupt Loop Control Word
        this.access(0x03);              // B = [S]
        this.S--;
        this.X = this.B % 0x8000000000;
        saveAROF = Math.floor(this.B / 0x400000000000) % 0x02;

        // restore the B register
        if (saveBROF || forTest) {
            this.access(0x03);          // B = [S]
            this.S--;
        }

        // restore the A register
        if (saveAROF || forTest) {
            this.access(0x02);          // A = [S]
            this.S--;
        }

        if (this.CWMF) {
            // exchange S with its field in X
            temp = this.S;
            this.S = (this.X % 0x40000000) >>> 15;
            this.X = this.X % 0x8000 +
                  temp * 0x8000 +
                  Math.floor(this.X / 0x40000000) * 0x40000000;
        }
    // else don't restore A or B for word mode -- will pop up as necessary
    }

    this.T = Math.floor(this.P / Math.pow(2, 36-this.L*12)) % 0x1000;   // ugly
    this.TROF = 1;
    if (forTest) {
        this.NCSF = (this.TM >>> 4) & 0x01;
        this.CCCF = (this.TM >>> 5) & 0x01;
        this.MWOF = (this.TM >>> 6) & 0x01;
        this.MROF = (this.TM >>> 7) & 0x01;
        this.S--;
        if (!this.CCCF) {
            this.TM |= 0x80;
        }
    } else {
        this.NCSF = 1;
        this.busy = true;
    }
}

/**************************************/
B5500Processor.prototype.run = function() {
    /* Instruction execution driver for the B5500 processor. This function is
    an artifact of the emulator design and does not represent any physical
    process or state of the processor. This routine assumes the registers are
    set up, and in particular a syllable is in T with TROF set. It will run
    until cycleCount >= cycleLimit or !this.busy */
    var opcode;
    var t1;
    var t2;
    var variant;

    do {
        this.Q = 0;
        this.Y = 0;
        this.Z = 0;
        opcode = this.T;
        if (this.CWMF) {
            /***********************************************************
            *  Character Mode Syllables                                *
            ***********************************************************/
            variant = opcode >>> 6;
            switch (opcode & 0x3F) {
            case 0x00:                  // XX00: CMX, EXC: Exit character mode
                break;

            case 0x02:                  // XX02: BSD=Skip bit destination
                break;

            case 0x03:                  // XX03: BSS=Skip bit source
                break;

            case 0x04:                  // XX04: RDA=Recall destination address
                break;

            case 0x05:                  // XX05: TRW=Transfer words
                break;

            case 0x06:                  // XX06: SED=Set destination address
                break;

            case 0x07:                  // XX07: TDA=Transfer destination address
                break;

            case 0x0A:                  // XX12: TBN=Transfer blank for numeric
                break;

            case 0x0C:                  // XX14: SDA=Store destination address
                break;

            case 0x0D:                  // XX15: SSA=Store source address
                break;

            case 0x0E:                  // XX16: SFD=Skip forward destination
                break;

            case 0x0F:                  // XX17: SRD=Skip reverse destination
                break;

            case 0x11:                  // XX11: control state ops
                switch (variant) {
                case 0x14:              // 2411: ZPI=Conditional Halt
                    break;

                case 0x18:              // 3011: SFI=Store for Interrupt
                    this.storeForInterrupt(false);
                    break;

                case 0x1C:              // 3411: SFT=Store for Test
                    this.storeForInterrupt(true);
                    break;

                default:                // Anything else is a no-op
                    break;
                } // end switch for XX11 ops
                break;

            case 0x12:                  // XX22: SES=Set source address
                break;

            case 0x14:                  // XX24: TEQ=Test for equal
                break;

            case 0x15:                  // XX25: TNE=Test for not equal
                break;

            case 0x16:                  // XX26: TEG=Test for greater or equal
                break;

            case 0x17:                  // XX27: TGR=Test for greater
                break;

            case 0x18:                  // XX30: SRS=Skip reverse source
                break;

            case 0x19:                  // XX31: SFS=Skip forward source
                break;

            case 0x1A:                  // XX32: ---=Field subtract (aux)       !! ??
                break;

            case 0x1B:                  // XX33: ---=Field add (aux)            !! ??
                break;

            case 0x1C:                  // XX34: TEL=Test for equal
                break;

            case 0x1D:                  // XX35: TLS=Test for less
                break;

            case 0x1E:                  // XX36: TAN=Test for alphanumeric
                break;

            case 0x1F:                  // XX37: BIT=Test bit
                break;

            case 0x20:                  // XX40: INC=Increase TALLY
                if (variant) {
                    this.R = (this.R + variant) & 0x3F;
                // else it's a character-mode no-op
                }
                break;

            case 0x21:                  // XX41: STC=Store TALLY
                break;

            case 0x22:                  // XX42: SEC=Set TALLY
                this.R = variant;
                break;

            case 0x23:                  // XX43: CRF=Call variant field
                break;

            case 0x24:                  // XX44: JNC=Jump out of loop conditional
                break;

            case 0x25:                  // XX45: JFC=Jump forward conditional
                break;

            case 0x26:                  // XX46: JNS=Jump out of loop
                break;

            case 0x27:                  // XX47: JFW=Jump forward unconditional
                break;

            case 0x28:                  // XX50: RCA=Recall control address
                break;

            case 0x29:                  // XX51: ENS=End loop
                break;

            case 0x2A:                  // XX52: BNS=Begin loop
                break;

            case 0x2B:                  // XX53: RSA=Recall source address
                break;

            case 0x2C:                  // XX54: SCA=Store control address
                break;

            case 0x2D:                  // XX55: JRC=Jump reverse conditional
                break;

            case 0x2E:                  // XX56: TSA=Transfer source address
                break;

            case 0x2F:                  // XX57: JRV=Jump reverse unconditional
                break;

            case 0x30:                  // XX60: CEQ=Compare equal
                break;

            case 0x31:                  // XX61: CNE=Compare not equal
                break;

            case 0x32:                  // XX62: CEG=Compare greater or equal
                break;

            case 0x33:                  // XX63: CGR=Compare greater
                break;

            case 0x34:                  // XX64: BIS=Set bit
                break;

            case 0x35:                  // XX65: BIR=Reset bit
                break;

            case 0x36:                  // XX66: OCV=Output convert
                break;

            case 0x37:                  // XX67: ICV=Input convert
                break;

            case 0x38:                  // XX70: CEL=Compare equal or less
                break;

            case 0x39:                  // XX71: CLS=Compare less
                break;

            case 0x3A:                  // XX72: FSU=Field subtract
                break;

            case 0x3B:                  // XX73: FAD=Field add
                break;

            case 0x3C:                  // XX74: TRP=Transfer program characters
                break;

            case 0x3D:                  // XX75: TRN=Transfer numerics
                break;

            case 0x3E:                  // XX76: TRZ=Transfer zones
                break;

            case 0x3F:                  // XX77: TRS=Transfer source characters
                break;

            default:                    // everything else is a no-op
                break;
            } // end switch for character mode operators
        } else {
            /***********************************************************
            *  Word Mode Syllables                                     *
            ***********************************************************/
            this.M = 0;
            this.N = 0;
            this.X = 0;
            switch (opcode & 3) {
            case 0:                     // LITC: Literal Call
                this.adjustAEmpty();
                this.A = opcode >>> 2;
                this.AROF = 1;
                break;

            case 2:                     // OPDC: Operand Call
                this.adjustAEmpty();
                // TO BE PROVIDED
                break;

            case 3:                     // DESC: Descriptor (name) Call
                this.adjustAEmpty();
                // TO BE PROVIDED
                break;

            case 1:                     // all other word-mode operators
                variant = opcode >>> 6;
                switch (opcode & 0x3F) {
                case 0x01:              // XX01: single-precision numerics
                    switch (variant) {
                    case 0x01:          // 0101: ADD=single-precision add
                        break;

                    case 0x03:          // 0301: SUB=single-precision subtract
                        break;

                    case 0x04:          // 0401: MUL=single-precision multiply
                        break;

                    case 0x08:          // 1001: DIV=single-precision floating divide
                        break;

                    case 0x18:          // 3001: IDV=integer divide
                        break;

                    case 0x38:          // 7001: RDV=remainder divide
                        break;
                    }
                    break;

                case 0x05:              // XX05: double-precision numerics
                    switch (variant) {
                    case 0x01:          // 0105: DLA=double-precision add
                        break;

                    case 0x03:          // 0305: DLS=double-precision subtract
                        break;

                    case 0x04:          // 0405: DLM=double-precision multiply
                        break;

                    case 0x08:          // 1005: DLD=double-precision floating divide
                        break;
                    }
                    break;

                case 0x09:              // XX11: control state and communication ops
                    switch (variant) {
                    case 0x01:          // 0111: PRL=Program Release
                        break;

                    case 0x10:          // 1011: COM=Communicate
                        if (this.NCSF) {        // no-op in control state
                            this.adjustAFull();
                            this.M = this.R + 0x09;     // address = R+@11
                            this.access(0x0C);  // [M] = A
                            this.AROF = 0;
                            this.I = (this.I & 0x0F) | 0x40;    // set I07
                            cc.signalInterrupt();
                        }
                        break;

                    case 0x02:          // 0211: ITI=Interrogate Interrupt
                        if (cc.IAR && !this.NCSF) {
                            this.C = cc.IAR;
                            this.L = 0;
                            this.S = 0x40;      // address @100
                            cc.clearInterrupt();
                            cc.access(0x30);    // P = [C]
                        }
                        break;

                    case 0x04:          // 0411: RTR=Read Timer
                        if (!this.NCSF) {      // control-state only
                            this.adjustAEmpty();
                            this.A = cc.CCI03F << 6 | cc.TM;
                        }
                        break;

                    case 0x11:          // 2111: IOR=I/O Release
                        break;

                    case 0x12:          // 2211: HP2=Halt Processor 2
                        if (!this.NCSF & cc.P2 && cc.P2BF) {
                            cc.HP2F = 1;
                            // We know P2 is not currently running on this thread, so save its registers
                            cc.P2.storeForInterrupt(false);
                            cc.P2BF = 0;
                            if (cc.P2.scheduler) {
                                cancelTimeout(cc.P2.scheduler);
                            }
                        }
                        break;

                    case 0x14:          // 2411: ZPI=Conditional Halt
                        break;

                    case 0x18:          // 3011: SFI=Store for Interrupt
                        this.storeForInterrupt(false);
                        break;

                    case 0x1C:          // 3411: SFT=Store for Test
                        this.storeForInterrupt(true);
                        break;

                    case 0x21:          // 4111: IP1=Initiate Processor 1
                        if (!this.NCSF) {
                            this.initiate(false);
                        }
                        break;

                    case 0x22:          // 4211: IP2=Initiate Processor 2
                        if (!this.NCSF) {
                            this.adjustAFull();
                            this.M = 8;             // INCW is stored in @10
                            this.access(0x0C);      // [M] = A
                            this.AROF = 0;
                            cc.initiateP2();
                            this.cycleLimit = 0;    // give P2 a chance to run
                        }
                        break;

                    case 0x24:          // 4411: IIO=Initiate I/O
                        break;

                    case 0x29:          // 5111: IFT=Initiate For Test
                        break;
                    } // end switch for XX11 ops
                    break;

                case 0x0D:              // XX15: logical (bitmask) ops
                    switch (variant) {
                    case 0x01:          // 0115: LNG=logical negate
                        break;

                    case 0x02:          // 0215: LOR=logical OR
                        break;

                    case 0x04:          // 0415: LND=logical AND
                        break;

                    case 0x08:          // 1015: LQV=logical EQV
                        break;

                    case 0x10:          // 2015: MOP=reset flag bit (make operand)
                        break;

                    case 0x20:          // 4015: MDS=set flag bit (make descriptor)
                        break;
                    }
                    break;

                case 0x11:              // XX21: load & store ops
                    switch (variant) {
                    case 0x01:          // 0121: CID=Conditional integer store descructive
                        break;

                    case 0x02:          // 0221: CIN=Conditional integer store nondestructive
                        break;

                    case 0x04:          // 0421: STD=Store destructive
                        break;

                    case 0x08:          // 1021: SND=Store nondestructive
                        break;

                    case 0x10:          // 2021: LOD=Load operand
                        break;

                    case 0x21:          // 4121: ISD=Integer store destructive
                        break;

                    case 0x22:          // 4221: ISN=Integer store nondestructive
                        break;
                    }
                    break;

                case 0x15:              // XX25: comparison & misc. stack ops
                    switch (variant) {
                    case 0x01:          // 0125: CEQ=compare B greater or equal to A
                        break;

                    case 0x02:          // 0225: CGR=compare B greater to A
                        break;

                    case 0x04:          // 0425: NEQ=compare B not equal to A
                        break;

                    case 0x08:          // 1025: XCH=exchange B with A
                        this.adjustAFull();
                        this.adjustBFull();
                        t1 = this.A;
                        this.A = this.B;
                        this.B = t1;
                        break;

                    case 0x0C:          // 1425: FTC=F field to core field
                        break;

                    case 0x10:          // 2025: DUP=Duplicate TOS
                        this.adjustAEmpty();
                        this.adjustBFull();
                        this.A = this.B;
                        this.AROF = 1;
                        break;

                    case 0x1C:          // 3425: FTF=F field to F field
                        break;

                    case 0x21:          // 4125: LEQ=compare B less or equal to A
                        break;

                    case 0x22:          // 4225: LSS=compare B less to A
                        break;

                    case 0x24:          // 4425: EQL=compare B equal to A
                        break;

                    case 0x2C:          // 5425: CTC=core field to C field
                        break;

                    case 0x3C:          // 7425: CTF=cre field to F field
                        break;
                    }
                    break;

                case 0x19:              // XX31: branch, sign-bit, interrogate ops
                    switch (variant) {
                    case 0x01:          // 0131: BBC=branch backward conditional
                        break;

                    case 0x02:          // 0231: BFC=branch forward conditional
                        break;

                    case 0x04:          // 0431: SSN=set sign bit (set negative)
                        break;

                    case 0x08:          // 1031: CHS=change sign bit
                        break;

                    case 0x10:          // 2031: TOP=test flag bit (test for operand)
                        break;

                    case 0x11:          // 2131: LBC=branch backward word conditional
                        break;

                    case 0x12:          // 2231: LFC=branch forward word conditional
                        break;

                    case 0x14:          // 2431: TUS=interrogate peripheral status
                        break;

                    case 0x21:          // 4131: BBW=branch backward unconditional
                        break;

                    case 0x22:          // 4231: BFW=branch forward unconditional
                        break;

                    case 0x24:          // 4431: SSP=reset sign bit (set positive)
                        break;

                    case 0x31:          // 6131: LBU=branch backward word unconditional
                        break;

                    case 0x32:          // 6231: LFU=branch forward word unconditional
                        break;

                    case 0x34:          // 6431: TIO=interrogate I/O channel
                        break;

                    case 0x38:          // 7031: FBS=stack search for flag
                        break;
                    }
                    break;

                case 0x1D:              // XX35: exit & return ops
                    switch (variant) {
                    case 0x01:          // 0135: BRT=branch return
                        break;

                    case 0x02:          // 0235: RTN=return normal
                        break;

                    case 0x04:          // 0435: XIT=exit procedure
                        break;

                    case 0x0A:          // 1235: RTS=return special
                        break;
                    }
                    break;

                case 0x21:              // XX41: index, mark stack, etc.
                    switch (variant) {
                    case 0x01:          // 0141: INX=index
                        break;

                    case 0x02:          // 0241: COC=construct operand call
                        break;

                    case 0x04:          // 0441: MKS=mark stack
                        break;

                    case 0x0A:          // 1241: CDC=construct descriptor call
                        break;

                    case 0x11:          // 2141: SSF=F & S register set/store
                        break;

                    case 0x15:          // 2541: LLL=link list lookup
                        break;

                    case 0x24:          // 4441: CMN=enter character mode inline
                        break;
                    }
                    break;

                case 0x25:              // XX45: ISO=Variable Field Isolate op
                    break;

                case 0x29:              // XX51: delete & conditional branch ops
                    if (variant == 0) { // 0065=DEL: delete TOS
                       if (this.AROF) {
                           this.AROF = 0;
                       } else if (this.BROF) {
                           this.BROF = 0;
                       } else {
                           this.S--;
                       }
                    } else {
                        switch (variant & 0x03) {
                        case 0x00:      // X051/X451: CFN=non-zero field branch forward nondestructive
                            break;

                        case 0x01:      // X151/X551: CBN=non-zero field branch backward nondestructive
                            break;

                        case 0x02:      // X251/X651: CFD=non-zero field branch forward destructive
                            break;

                        case 0x03:      // X351/X751: CBD=non-zero field branch backward destructive
                            break;
                        }
                    }
                    break;

                case 0x2D:              // XX55: NOP & DIA=Dial A ops
                    if (opcode & 0xFC0) {
                        this.G = variant >>> 3;
                        this.H = (variant) & 7;
                    // else             // 0055: NOP=no operation (the official one, at least)
                    }
                    break;

                case 0x31:              // XX61: XRT & DIB=Dial B ops
                    if (opcode & 0xFC0) {
                        this.K = variant >>> 3;
                        this.V = (variant) & 7;
                    } else {            // 0061=XRT: temporarily set full PRT addressing mode
                        this.VARF = this.SALF;
                        this.SALF = 0;
                    }
                    break;

                case 0x35:              // XX65: TRB=Transfer Bits
                    this.adjustAFull();
                    this.adjustBFull();
                    t1 = this.G <<< 3 | this.H; // A register starting bit nr
                    if (t1+variant > 48) {
                        variant = 48-t1;
                    }
                    t2 = this.K <<< 3 | this.V; // B register starting bit nr
                    if (t2+variant > 48) {
                        variant = 48-t2;
                    }
                    if (variant > 0) {
                        this.B = cc.insert(this.B, t2, variant, cc.isolate(this.A, t1, variant));
                    }
                    this.AROF = 0;
                    this.cycleCount += variant + this.G + this.K;       // approximate the shift counts
                    break;

                case 0x39:              // XX71: FCL=Compare Field Low
                    this.adjustAFull();
                    this.adjustBFull();
                    t1 = this.G <<< 3 | this.H; // A register starting bit nr
                    if (t1+variant > 48) {
                        variant = 48-t1;
                    }
                    t2 = this.K <<< 3 | this.V; // B register starting bit nr
                    if (t2+variant > 48) {
                        variant = 48-t2;
                    }
                    if (variant > 0 && cc.isolate(this.B, t2, variant) < cc.isolate(this.A, t1, variant)) {
                        this.A = 1;
                    } else {
                        this.A = 0;
                    }
                    this.cycleCount += variant + this.G + this.K;       // approximate the shift counts
                    break;

                case 0x3D:              // XX75: FCE=Compare Field Equal
                    this.adjustAFull();
                    this.adjustBFull();
                    t1 = this.G <<< 3 | this.H; // A register starting bit nr
                    if (t1+variant > 48) {
                        variant = 48-t1;
                    }
                    t2 = this.K <<< 3 | this.V; // B register starting bit nr
                    if (t2+variant > 48) {
                        variant = 48-t2;
                    }
                    if (variant > 0 && cc.isolate(this.B, t2, variant) == cc.isolate(this.A, t1, variant)) {
                        this.A = 1;
                    } else {
                        this.A = 0;
                    }
                    this.cycleCount += variant + this.G + this.K;       // approximate the shift counts
                    break;

                default:
                    break;              // anything else is a no-op
                } // end switch for non-LITC/OPDC/DESC operators
                break;
            } // end switch for word-mode operators
        } // end main switch for opcode dispatch

        /***************************************************************
        *   SECL: Syllable Execution Complete Level                    *
        ***************************************************************/
        if ((this === cc.P1 ? cc.IAR : this.I) && this.NCSF) {
            // there's an interrupt and we're in normal state
            this.T = 0x0609;            // inject 3011=SFI into T
            this.Q |= 0x40              // set Q07F to indicate hardware-induced SFI
            this.Q &= ~(0x100);         // reset Q09F: adder mode for R-relative addressing
        } else {
            // otherwise, fetch the next instruction
            switch (this.L) {
            case 0:
                this.T = Math.Floor(this.P / 0x1000000000) % 0x1000;
                this.L++;
            case 1:
                this.T = Math.Floor(this.P / 0x1000000) % 0x1000;
                this.L++;
            case 2:
                this.T = Math.Floor(this.P / 0x1000) % 0x1000;
                this.L++;
            case 3:
                this.T = this.P % 0x1000;
                this.L = 0;
                this.C++;
                this.access(0x30);      // P = [C]
            }
        }
    } while ((this.cycleCount += 2) < this.cycleLimit && this.busy);
}

/**************************************/
B5500Processor.prototype.schedule = function() {
    /* Schedules the processor run time and attempts to throttle performance
    to approximate that of a real B5500. Well, at least we hope this will run
    fast enough that the performance will need to be throttled. It establishes
    a timeslice in terms of a number of processor "cycles" of 1 microsecond
    each and calls run() to execute at most that number of cycles. run()
    counts up cycles until it reaches this limit or some terminating event
    (such as a halt), then exits back here. If the processor remains active,
    this routine will reschedule itself for an appropriate later time, thereby
    throttling the performance and allowing other modules a chance at the
    Javascript execution thread. */
    var delayTime;

    this.scheduler = null;
    this.cycleLimit = this.timeSlice;
    this.cycleCount = 0;

    this.run();

    this.totalCycles += this.cycleCount
    this.procTime += this.cycleCount;
    if (this.busy) {
        delayTime = this.procTime/1000 - new Date().getTime();
        this.scheduleSlack += delayTime;
        this.scheduler = setTimeout(this.schedule, (delayTime < 0 ? 0 : delayTime));
    }
}