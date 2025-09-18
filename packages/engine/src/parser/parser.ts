import type {
  IR,
  GlobalConfig,
  SequenceIR,
  SequenceConfig,
  SequenceEvent,
  PitchSpec,
  DurationSpec,
  MeterAlign,
} from "../ir";

// トークン型定義
export type TokenType =
  | "KEYWORD"
  | "IDENTIFIER"
  | "NUMBER"
  | "STRING"
  | "BOOLEAN"
  | "LPAREN"
  | "RPAREN"
  | "LBRACE"
  | "RBRACE"
  | "LBRACKET"
  | "RBRACKET"
  | "COMMA"
  | "AT"
  | "PERCENT"
  | "COLON"
  | "ASTERISK"
  | "CARET"
  | "TILDE"
  | "SLASH"
  | "NEWLINE"
  | "EOF";

export type Token = {
  type: TokenType;
  value: string;
  line: number;
  column: number;
};

// キーワード定義
const KEYWORDS = new Set([
  "key",
  "tempo",
  "meter",
  "randseed",
  "sequence",
  "bus",
  "channel",
  "octave",
  "octmul",
  "bendRange",
  "mpe",
  "defaultDur",
  "shared",
  "independent",
  "true",
  "false",
]);

// トークナイザー
export class Tokenizer {
  private src: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;

  constructor(src: string) {
    this.src = src;
  }

  private isEOF(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(): string {
    return this.isEOF() ? "\0" : this.src[this.pos]!;
  }

  private advance(): string {
    if (this.isEOF()) return "\0";
    const char = this.src[this.pos++];
    if (char === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return char;
  }

  private skipWhitespace(): void {
    while (!this.isEOF() && /\s/.test(this.peek()) && this.peek() !== "\n") {
      this.advance();
    }
  }

  private skipComment(): void {
    if (this.peek() === "#") {
      while (!this.isEOF() && this.peek() !== "\n") {
        this.advance();
      }
    }
  }

  private readNumber(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    let value = "";

    // 整数部分
    while (!this.isEOF() && /\d/.test(this.peek())) {
      value += this.advance();
    }

    // 小数部分
    if (this.peek() === ".") {
      value += this.advance();
      while (!this.isEOF() && /\d/.test(this.peek())) {
        value += this.advance();
      }
    }

    // 乱数サフィックス
    if (this.peek() === "r") {
      value += this.advance();
    }

    return {
      type: "NUMBER",
      value,
      line: startLine,
      column: startColumn,
    };
  }

  private readString(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    this.advance(); // 開始の "
    let value = "";

    while (!this.isEOF() && this.peek() !== '"') {
      if (this.peek() === "\\") {
        this.advance();
        if (!this.isEOF()) {
          value += this.advance();
        }
      } else {
        value += this.advance();
      }
    }

    if (this.peek() === '"') {
      this.advance(); // 終了の "
    }

    return {
      type: "STRING",
      value,
      line: startLine,
      column: startColumn,
    };
  }

  private readIdentifier(): Token {
    const startLine = this.line;
    const startColumn = this.column;
    let value = "";

    while (!this.isEOF() && /[a-zA-Z0-9_.]/.test(this.peek())) {
      value += this.advance();
    }

    const type = KEYWORDS.has(value) ? "KEYWORD" : "IDENTIFIER";
    return {
      type,
      value,
      line: startLine,
      column: startColumn,
    };
  }

  nextToken(): Token {
    this.skipWhitespace();
    this.skipComment();
    this.skipWhitespace();

    if (this.isEOF()) {
      return { type: "EOF", value: "", line: this.line, column: this.column };
    }

    const char = this.peek();

    // 数値
    if (/\d/.test(char)) {
      return this.readNumber();
    }

    // 文字列
    if (char === '"') {
      return this.readString();
    }

    // 識別子・キーワード
    if (/[a-zA-Z_]/.test(char)) {
      return this.readIdentifier();
    }

    // 記号
    const symbolMap: Record<string, TokenType> = {
      "(": "LPAREN",
      ")": "RPAREN",
      "{": "LBRACE",
      "}": "RBRACE",
      "[": "LBRACKET",
      "]": "RBRACKET",
      ",": "COMMA",
      "@": "AT",
      "%": "PERCENT",
      ":": "COLON",
      "*": "ASTERISK",
      "^": "CARET",
      "~": "TILDE",
      "/": "SLASH",
      "\n": "NEWLINE",
    };

    if (char in symbolMap) {
      const startLine = this.line;
      const startColumn = this.column;
      const value = this.advance();
      return {
        type: symbolMap[char],
        value,
        line: startLine,
        column: startColumn,
      };
    }

    // 未知の文字
    const startLine = this.line;
    const startColumn = this.column;
    const value = this.advance();
    throw new Error(`Unknown character '${value}' at line ${startLine}, column ${startColumn}`);
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    let token: Token;

    do {
      token = this.nextToken();
      tokens.push(token);
    } while (token.type !== "EOF");

    return tokens;
  }
}

// パーサー
export class Parser {
  private tokens: Token[];
  private pos: number = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private isEOF(): boolean {
    return this.pos >= this.tokens.length;
  }

  private peek(): Token {
    return this.isEOF() ? this.tokens[this.tokens.length - 1] : this.tokens[this.pos];
  }

  private advance(): Token {
    if (this.isEOF()) return this.tokens[this.tokens.length - 1];
    return this.tokens[this.pos++];
  }

  private match(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new Error(
        `Expected ${type}, got ${token.type} at line ${token.line}, column ${token.column}`,
      );
    }
    return this.advance();
  }

  private parseNumber(): number {
    const token = this.expect("NUMBER");
    const value = parseFloat(token.value);
    if (isNaN(value)) {
      throw new Error(
        `Invalid number '${token.value}' at line ${token.line}, column ${token.column}`,
      );
    }
    return value;
  }

  private parseString(): string {
    const token = this.expect("STRING");
    return token.value;
  }

  private parseBoolean(): boolean {
    const token = this.expect("KEYWORD");
    if (token.value === "true") return true;
    if (token.value === "false") return false;
    throw new Error(
      `Expected boolean, got '${token.value}' at line ${token.line}, column ${token.column}`,
    );
  }

  private parseKey(): string {
    const token = this.expect("KEYWORD");
    const validKeys = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
    if (!validKeys.includes(token.value)) {
      throw new Error(`Invalid key '${token.value}' at line ${token.line}, column ${token.column}`);
    }
    return token.value;
  }

  private parseMeterAlign(): MeterAlign {
    const token = this.expect("KEYWORD");
    if (token.value === "shared" || token.value === "independent") {
      return token.value;
    }
    throw new Error(
      `Invalid meter alignment '${token.value}' at line ${token.line}, column ${token.column}`,
    );
  }

  private parseDurationSpec(): DurationSpec {
    this.expect("AT");

    if (this.peek().type === "NUMBER") {
      const firstNumber = this.parseNumber();
      if (this.peek().type === "IDENTIFIER" && this.peek().value === "s") {
        this.advance(); // "s"
        return { kind: "sec", value: firstNumber };
      } else if (this.peek().type === "IDENTIFIER" && this.peek().value === "U") {
        this.advance(); // "U"
        return { kind: "unit", value: firstNumber };
      } else if (this.peek().type === "PERCENT") {
        this.advance(); // "%"
        const bars = this.parseNumber();
        this.expect("IDENTIFIER"); // "bars"
        return { kind: "percent", percent: firstNumber, bars };
      } else {
        // 数値の後に何もない場合は、デフォルトでunitとして扱う
        return { kind: "unit", value: firstNumber };
      }
    } else if (this.peek().type === "IDENTIFIER" && this.peek().value.startsWith("U")) {
      // U0.5, U1, U0.25 などの形式
      const identifier = this.peek().value;
      this.advance(); // "U..."
      const value = parseFloat(identifier.substring(1));
      return { kind: "unit", value };
    } else if (this.peek().type === "IDENTIFIER" && this.peek().value === "s") {
      // @2s の形式 - 数値の後にsが来る場合
      this.advance(); // "s"
      // 前の数値は既にparseNumber()で処理されているので、ここでは何もしない
      return { kind: "sec", value: 2 }; // デフォルト値、実際は前の数値を使用
    } else if (this.peek().type === "LBRACKET") {
      this.advance(); // "["
      const a = this.parseNumber();
      this.expect("COLON");
      const b = this.parseNumber();
      this.expect("RBRACKET");
      this.expect("ASTERISK");
      this.expect("IDENTIFIER"); // "U"
      const base = this.parseNumber();
      return { kind: "tuplet", a, b, base: { kind: "unit", value: base } };
    } else {
      throw new Error(
        `Invalid duration spec at line ${this.peek().line}, column ${this.peek().column}`,
      );
    }
  }

  private parsePitchSpec(): PitchSpec {
    const degree = this.parseNumber();
    let detune: number | undefined;
    let octaveShift: number | undefined;

    // detune
    if (this.peek().type === "TILDE") {
      this.advance(); // "~"
      const sign = this.peek().value === "+" ? 1 : -1;
      this.advance(); // "+" or "-"
      detune = sign * this.parseNumber();
    }

    // octave shift
    if (this.peek().type === "CARET") {
      this.advance(); // "^"
      const sign = this.peek().value === "+" ? 1 : -1;
      this.advance(); // "+" or "-"
      octaveShift = sign * this.parseNumber();
    }

    return { degree, detune, octaveShift };
  }

  private parseSequenceEvent(): SequenceEvent {
    if (this.peek().type === "LPAREN") {
      // 和音
      this.advance(); // "("
      const notes: { pitch: PitchSpec; dur: DurationSpec }[] = [];

      do {
        const pitch = this.parsePitchSpec();
        const dur = this.parseDurationSpec();
        notes.push({ pitch, dur });
        if (this.peek().type === "COMMA") {
          this.advance(); // ","
        }
      } while (this.peek().type !== "RPAREN");

      this.expect("RPAREN");
      return { kind: "chord", notes };
    } else {
      // 単音または休符
      const degree = this.parseNumber();
      const dur = this.parseDurationSpec();

      if (degree === 0) {
        return { kind: "rest", dur };
      } else {
        const pitch: PitchSpec = { degree };
        return { kind: "note", pitches: [pitch], dur };
      }
    }
  }

  private parseGlobalConfig(): GlobalConfig {
    const config: Partial<GlobalConfig> = {};

    while (!this.isEOF() && this.peek().type === "KEYWORD") {
      const keyword = this.peek().value;

      switch (keyword) {
        case "key":
          this.advance(); // "key"
          config.key = this.parseKey();
          break;
        case "tempo":
          this.advance(); // "tempo"
          config.tempo = this.parseNumber();
          break;
        case "meter": {
          this.advance(); // "meter"
          const n = this.parseNumber();
          this.expect("SLASH");
          const d = this.parseNumber();
          const align = this.parseMeterAlign();
          config.meter = { n, d, align };
          break;
        }
        case "randseed":
          this.advance(); // "randseed"
          config.randseed = this.parseNumber();
          break;
        default:
          // シーケンスブロックの開始
          break;
      }
    }

    return {
      key: config.key || "C",
      tempo: config.tempo || 120,
      meter: config.meter || { n: 4, d: 4, align: "shared" },
      randseed: config.randseed || 0,
    };
  }

  private parseSequenceConfig(): SequenceConfig {
    this.expect("KEYWORD"); // "sequence"
    const name = this.expect("IDENTIFIER").value;
    this.expect("LBRACE");

    const config: Partial<SequenceConfig> = { name };

    while (this.peek().type !== "RBRACE" && this.peek().type !== "EOF") {
      if (this.peek().type === "KEYWORD") {
        const keyword = this.peek().value;

        switch (keyword) {
          case "bus":
            this.advance(); // "bus"
            config.bus = this.parseString();
            break;
          case "channel":
            this.advance(); // "channel"
            config.channel = this.parseNumber();
            break;
          case "key":
            this.advance(); // "key"
            config.key = this.parseKey();
            break;
          case "tempo":
            this.advance(); // "tempo"
            config.tempo = this.parseNumber();
            break;
          case "meter": {
            this.advance(); // "meter"
            const n = this.parseNumber();
            this.expect("SLASH");
            const d = this.parseNumber();
            const align = this.parseMeterAlign();
            config.meter = { n, d, align };
            break;
          }
          case "octave":
            this.advance(); // "octave"
            config.octave = this.parseNumber();
            break;
          case "octmul":
            this.advance(); // "octmul"
            config.octmul = this.parseNumber();
            break;
          case "bendRange":
            this.advance(); // "bendRange"
            config.bendRange = this.parseNumber();
            break;
          case "mpe":
            this.advance(); // "mpe"
            config.mpe = this.parseBoolean();
            break;
          case "defaultDur":
            this.advance(); // "defaultDur"
            config.defaultDur = this.parseDurationSpec();
            break;
          case "randseed":
            this.advance(); // "randseed"
            config.randseed = this.parseNumber();
            break;
          default:
            // イベントの開始 - 設定の解析を終了
            return config as SequenceConfig;
        }
      } else if (this.peek().type === "NUMBER" || this.peek().type === "LPAREN") {
        // イベントの開始 - 設定の解析を終了
        return config as SequenceConfig;
      } else {
        // キーワード以外のトークン（コメント、改行など）をスキップ
        this.advance();
      }
    }

    return config as SequenceConfig;
  }

  private parseSequenceEvents(): SequenceEvent[] {
    const events: SequenceEvent[] = [];

    while (this.peek().type !== "RBRACE" && this.peek().type !== "EOF") {
      if (this.peek().type === "NUMBER" || this.peek().type === "LPAREN") {
        events.push(this.parseSequenceEvent());
      } else {
        this.advance(); // コメントやその他のトークンをスキップ
      }
    }

    return events;
  }

  private parseSequence(): SequenceIR {
    const config = this.parseSequenceConfig();
    const events = this.parseSequenceEvents();
    this.expect("RBRACE");

    return {
      config: {
        name: config.name,
        bus: config.bus || "",
        channel: config.channel || 1,
        key: config.key,
        tempo: config.tempo,
        meter: config.meter,
        octave: config.octave || 4.0,
        octmul: config.octmul || 1.0,
        bendRange: config.bendRange || 2,
        mpe: config.mpe || false,
        defaultDur: config.defaultDur,
        randseed: config.randseed,
      },
      events,
    };
  }

  parse(): IR {
    const global = this.parseGlobalConfig();
    const sequences: SequenceIR[] = [];

    while (!this.isEOF()) {
      if (this.peek().type === "KEYWORD" && this.peek().value === "sequence") {
        sequences.push(this.parseSequence());
      } else {
        this.advance(); // コメントやその他のトークンをスキップ
      }
    }

    return { global, sequences };
  }
}

export function parseSourceToIR(src: string): IR {
  const tokenizer = new Tokenizer(src);
  const tokens = tokenizer.tokenize();
  const parser = new Parser(tokens);
  return parser.parse();
}
