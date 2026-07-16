/**
 * Deterministic LaTeX-to-speech: renders common textbook LaTeX as the words a
 * lecturer would say, symbol by symbol, left to right. Returns null the
 * moment it meets anything it does not fully understand — callers fall back
 * to the LLM (or a generic phrase) rather than risk a wrong reading.
 *
 * This carries the exact part of equation narration; the LLM only ever adds
 * interpretation on top ("here gamma is the discount factor"), never the
 * reading itself.
 */

const GREEK = new Set([
	'alpha',
	'beta',
	'gamma',
	'delta',
	'epsilon',
	'varepsilon',
	'zeta',
	'eta',
	'theta',
	'vartheta',
	'iota',
	'kappa',
	'lambda',
	'mu',
	'nu',
	'xi',
	'pi',
	'rho',
	'sigma',
	'tau',
	'upsilon',
	'phi',
	'varphi',
	'chi',
	'psi',
	'omega'
]);

const FUNCTIONS = new Set([
	'log',
	'ln',
	'sin',
	'cos',
	'tan',
	'exp',
	'min',
	'max',
	'arg',
	'det',
	'lim',
	'argmax',
	'argmin'
]);

const SYMBOL_WORDS: Record<string, string> = {
	sim: 'is distributed as',
	approx: 'is approximately',
	propto: 'is proportional to',
	le: 'is less than or equal to',
	leq: 'is less than or equal to',
	ge: 'is greater than or equal to',
	geq: 'is greater than or equal to',
	ne: 'is not equal to',
	neq: 'is not equal to',
	ll: 'is much less than',
	gg: 'is much greater than',
	pm: 'plus or minus',
	mp: 'minus or plus',
	times: 'times',
	cdot: 'dot',
	div: 'divided by',
	mid: 'given',
	in: 'is in',
	to: 'goes to',
	rightarrow: 'goes to',
	mapsto: 'maps to',
	infty: 'infinity',
	partial: 'partial',
	nabla: 'nabla',
	ell: 'ell',
	prime: 'prime'
};

const SKIP_COMMANDS = new Set([
	'left',
	'right',
	'displaystyle',
	'limits',
	'nolimits',
	'big',
	'Big',
	'bigg',
	'Bigg'
]);
const SPACE_COMMANDS = new Set([',', ';', '!', ':', ' ']);
const SMALL_NUMBERS: Record<string, string> = {
	'0': 'zero',
	'1': 'one',
	'2': 'two',
	'3': 'three',
	'4': 'four',
	'5': 'five',
	'6': 'six',
	'7': 'seven',
	'8': 'eight',
	'9': 'nine'
};

class UnknownLatex extends Error {}

class Reader {
	position = 0;
	constructor(public source: string) {}

	get done(): boolean {
		return this.position >= this.source.length;
	}

	peek(): string {
		return this.source[this.position] ?? '';
	}

	next(): string {
		return this.source[this.position++] ?? '';
	}

	/** Read a {…} group (balanced) or a single atom after _ ^ etc. */
	readGroup(): string {
		while (this.peek() === ' ') this.next();
		if (this.peek() === '{') {
			this.next();
			let depth = 1;
			let content = '';
			while (!this.done) {
				const char = this.next();
				if (char === '{') depth += 1;
				else if (char === '}') {
					depth -= 1;
					if (depth === 0) return content;
				}
				if (depth > 0) content += char;
			}
			throw new UnknownLatex('unbalanced group');
		}
		if (this.peek() === '\\') {
			this.next();
			let command = '';
			while (/[a-zA-Z]/.test(this.peek())) command += this.next();
			return `\\${command}`;
		}
		return this.next();
	}

	readCommand(): string {
		let command = '';
		while (/[a-zA-Z]/.test(this.peek())) command += this.next();
		if (!command) {
			// "\," "\;" "\!" "\ " single-char commands
			return this.next();
		}
		return command;
	}
}

function isIdentifierWord(word: string): boolean {
	return /^[A-Za-z]$/.test(word) || GREEK.has(word) || FUNCTIONS.has(word) || word === 'prime';
}

function bigOperator(name: 'sum' | 'product' | 'integral', reader: Reader): string {
	let lower = '';
	let upper = '';
	for (;;) {
		while (reader.peek() === ' ') reader.next();
		if (reader.peek() === '_') {
			reader.next();
			lower = speakFragment(reader.readGroup());
		} else if (reader.peek() === '^') {
			reader.next();
			upper = speakFragment(reader.readGroup());
		} else break;
	}
	if (lower && upper) return `the ${name} from ${lower} to ${upper} of`;
	if (lower) return `the ${name} over ${lower} of`;
	return `the ${name} of`;
}

function speakFragment(fragment: string): string {
	return speakTokens(new Reader(fragment)).join(' ');
}

function speakTokens(reader: Reader): string[] {
	const words: string[] = [];
	const last = () => words.at(-1) ?? '';
	const push = (word: string) => {
		if (word) words.push(word);
	};
	const pushPause = () => {
		if (words.length && last() !== ',') push(',');
	};

	while (!reader.done) {
		const char = reader.next();

		if (char === ' ' || char === '\n' || char === '\t' || char === '}' || char === '{') continue;

		if (char === '\\') {
			const command = reader.readCommand();
			if (SPACE_COMMANDS.has(command)) continue;
			if (SKIP_COMMANDS.has(command)) continue;
			if (command === 'quad' || command === 'qquad') {
				pushPause();
				continue;
			}
			if (command === 'sum') {
				pushPause();
				push(bigOperator('sum', reader));
				continue;
			}
			if (command === 'prod') {
				pushPause();
				push(bigOperator('product', reader));
				continue;
			}
			if (command === 'int') {
				pushPause();
				push(bigOperator('integral', reader));
				continue;
			}
			if (command === 'frac') {
				const numerator = speakFragment(reader.readGroup());
				const denominator = speakFragment(reader.readGroup());
				push(`${numerator} over ${denominator}`);
				continue;
			}
			if (command === 'sqrt') {
				push(`the square root of ${speakFragment(reader.readGroup())}`);
				continue;
			}
			if (
				command === 'mathbb' ||
				command === 'mathcal' ||
				command === 'mathrm' ||
				command === 'operatorname'
			) {
				const group = reader.readGroup();
				if (group === 'E') push('the expected value of');
				else if (group === 'R') push('the real numbers');
				else if (group === 'P') push('the probability of');
				else push(speakFragment(group));
				continue;
			}
			if (command === 'text') {
				push(reader.readGroup().trim());
				continue;
			}
			if (command === 'bar' || command === 'hat' || command === 'tilde' || command === 'vec') {
				const suffix = command === 'vec' ? 'vector' : command;
				push(`${speakFragment(reader.readGroup())} ${suffix}`);
				continue;
			}
			if (command === 'lVert' || command === 'Vert' || command === 'lvert') {
				push('the norm of');
				continue;
			}
			if (command === 'rVert' || command === 'rvert') continue;
			if (GREEK.has(command.toLowerCase())) {
				push(command.toLowerCase());
				continue;
			}
			if (FUNCTIONS.has(command)) {
				push(command);
				continue;
			}
			if (command in SYMBOL_WORDS) {
				push(SYMBOL_WORDS[command]);
				continue;
			}
			throw new UnknownLatex(`\\${command}`);
		}

		if (char === '_') {
			push(`sub ${speakFragment(reader.readGroup())}`);
			continue;
		}
		if (char === '^') {
			const raw = reader.readGroup();
			if (raw === '2') {
				push('squared');
				continue;
			}
			if (raw === '3') {
				push('cubed');
				continue;
			}
			const exponent = speakFragment(raw);
			if (GREEK.has(exponent)) push(exponent);
			else push(`to the ${exponent}`);
			continue;
		}
		if (char === "'") {
			push('prime');
			continue;
		}
		if (char === '(') {
			// "π(a|s)" and "π sub θ(…)" both read as function application.
			const lastWord = last().split(' ').at(-1) ?? '';
			push(isIdentifierWord(lastWord) ? 'of' : '');
			continue;
		}
		if (char === ')' || char === ']') continue;
		if (char === '[') {
			pushPause();
			continue;
		}
		if (char === ',') {
			// Inside function arguments "P(s, a)" reads "and"; elsewhere a pause.
			if (
				reader.source.slice(0, reader.position).lastIndexOf('(') >
				reader.source.slice(0, reader.position).lastIndexOf(')')
			) {
				push('and');
			} else {
				pushPause();
			}
			continue;
		}
		if (char === '=') {
			push('equals');
			continue;
		}
		if (char === '+') {
			push('plus');
			continue;
		}
		if (char === '-') {
			push('minus');
			continue;
		}
		if (char === '*') {
			push('times');
			continue;
		}
		if (char === '/') {
			push('over');
			continue;
		}
		if (char === '<') {
			push('is less than');
			continue;
		}
		if (char === '>') {
			push('is greater than');
			continue;
		}
		if (char === '|') {
			push('given');
			continue;
		}
		if (/[0-9]/.test(char)) {
			let number = char;
			while (/[0-9.]/.test(reader.peek())) number += reader.next();
			number = number.replace(/\.$/, '');
			push(SMALL_NUMBERS[number] ?? number);
			continue;
		}
		if (/[a-zA-Z]/.test(char)) {
			push(char);
			continue;
		}
		if (char === '.' || char === ';' || char === ':') {
			pushPause();
			continue;
		}
		throw new UnknownLatex(char);
	}
	return words;
}

/**
 * The spoken reading of a LaTeX expression, or null when any part of it is
 * not confidently understood. Output is a lowercase-led phrase with no
 * terminal period — callers capitalize/punctuate as needed.
 */
export function latexToSpeech(latex: string): string | null {
	const trimmed = latex.trim();
	if (!trimmed) return null;
	try {
		const words = speakTokens(new Reader(trimmed));
		const text = words
			.join(' ')
			.replace(/\s+,/g, ',')
			.replace(/,(\s*,)+/g, ',')
			.replace(/^[,\s]+|[,\s]+$/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		return text || null;
	} catch (error) {
		if (error instanceof UnknownLatex) return null;
		throw error;
	}
}
