/** @module Yuuko */

import fs from 'fs';
import path from 'path';
import * as Eris from 'eris';
import {Command, CommandRequirements, CommandContext} from './Command';
import {EventListener, EventContext} from './EventListener';
import defaultMessageListener from './defaultMessageListener';
import {Resolved, Resolves, makeArray} from './util';

/** The options passed to the client constructor. Includes Eris options. */
export interface ClientOptions extends Eris.ClientOptions {
	/** The bot's token. */
	token: string;
	/** The prefix used to trigger commands. */
	prefix: string;
	/** If true, prefix matching is case-sensitive. */
	caseSensitivePrefix?: boolean;
	/**
	 * If true, command names are case-sensitive. For example, users may use
	 * !ping and !PING interchangeably (assuming ! is a valid prefix). If false,
	 * command names in code must be all lowercase.
	 */
	caseSensitiveCommands?: boolean;
	/** If true, the bot's mention can be used as an additional prefix. */
	allowMention?: boolean;
	/** If true, messages from other bot accounts will not trigger commands. */
	ignoreBots?: boolean;
	/**
	 * If true, requirements set via setGlobalRequirements will be ignored. Used
	 * for debugging, probably shouldn't be used in production.
	*/
	ignoreGlobalRequirements?: boolean;

	/**
	 * If true, the client does not respond to commands by default, and the user
	 * must register their own `messageCreate` listener, which can call
	 * `processCommand` to perform command handling at an arbitrary point during
	 * the handler's execution
	 */
	disableDefaultMessageHandler?: boolean;

}

/** Information returned from the API about the bot's OAuth application. */
// TODO: obviated by https://github.com/abalabahaha/eris/pull/467
export interface ClientOAuthApplication extends Resolved<ReturnType<Client['getOAuthApplication']>> {
	// nothing else added
}

// A function that takes a message and a context argument and returns a prefix,
// an array of prefixes, or void.
export interface PrefixFunction {
	(msg: Eris.Message, ctx: EventContext): Resolves<string | string[] | null | undefined>;
}

/** The client. */
export class Client extends Eris.Client implements ClientOptions {
	/** The token of the bot. */
	token: string;

	/** The prefix used to trigger commands. */
	prefix: string;

	/** If true, prefix matching is case-sensitive. */
	caseSensitivePrefix: boolean = true;

	/**
	 * If true, command names are case-sensitive. For example, users may use
	 * !ping and !PING interchangeably (assuming ! is a valid prefix). If false,
	 * command names in code must be all lowercase.
	 */
	caseSensitiveCommands: boolean = false;

	/** If true, the bot's mention can be used as an additional prefix. */
	allowMention: boolean = true;

	/** If true, messages from other bot accounts will not trigger commands. */
	ignoreBots: boolean = true;

	/**
	 * If true, requirements set via setGlobalRequirements will be ignored. Used
	 * for debugging, probably shouldn't be used in production.
	 */
	ignoreGlobalRequirements: boolean = false;

	/**
	 * If true, the client does not respond to commands by default, and the user
	 * must register their own `messageCreate` listener, which can call
	 * `processCommand` to perform command handling at an arbitrary point during
	 * the handler's execution
	 */
	disableDefaultMessageHandler: boolean = false;

	/** A list of all loaded commands. */
	commands: Command[] = [];

	/** A list of all registered event listeners. */
	events: EventListener[] = [];

	/**
	 * The default command, executed if `allowMention` is true and the bot is
	 * pinged without a command
	 */
	defaultCommand: Command | null = null;

	/** A custom function that determines the command prefix per message. */
	prefixFunction?: PrefixFunction;

	/**
	 * A regular expression which matches mention prefixes. Present after the
	 * first `'ready'` event is sent.
	*/
	mentionPrefixRegExp: RegExp | null = null;

	/** Information about the bot's OAuth application. */
	app: ClientOAuthApplication | null = null;

	/** An object of stuff to add to the context object for command functions */
	contextAdditions: object = {};

	/** A requirements object that is applied to all commands */
	globalCommandRequirements: CommandRequirements = {};

	/** @hidden Whether or not the ready event has been emitted at least once */
	private _gotReady: boolean = false;

	constructor (options: ClientOptions) {
		super(options.token, options); // Do Eris client constructor stuff
		// HACK: Technically this is already set by the super constructor, but
		//       Eris defines token as an optional property even though it's not
		this.token = options.token;

		// Apply options on top of defaults
		// Object.assign(this, options); // eventually maybe we can just do this
		this.prefix = options.prefix;
		if (options.caseSensitivePrefix !== undefined) this.caseSensitivePrefix = options.caseSensitivePrefix;
		if (options.caseSensitiveCommands !== undefined) this.caseSensitiveCommands = options.caseSensitiveCommands;
		if (options.allowMention !== undefined) this.allowMention = options.allowMention;
		if (options.ignoreBots !== undefined) this.ignoreBots = options.ignoreBots;
		if (options.ignoreGlobalRequirements !== undefined) this.ignoreGlobalRequirements = options.ignoreGlobalRequirements;
		if (options.disableDefaultMessageHandler !== undefined) this.disableDefaultMessageHandler = options.disableDefaultMessageHandler;

		// Warn if we're using an empty prefix
		if (this.prefix === '') {
			process.emitWarning('prefx is an empty string; bot will not require a prefix to run commands');
		}

		// Register the default message listener unless it's disabled
		if (!this.disableDefaultMessageHandler) {
			this.addEvent(defaultMessageListener);
		}
	}

	/** Returns an EventContext object with all the current context */
	get eventContext (): EventContext {
		return Object.assign({client: this}, this.contextAdditions);
	}

	/**
	 * @override
	 * @hidden
	 * Hijacks the `'ready'` event so we can do custom setup.
	 */
	emit (name: string, ...args: any[]): boolean {
		// We only want to customize the 'ready' event the first time
		if (name !== 'ready' || this._gotReady) return super.emit(name, ...args);
		this._gotReady = true;
		this.mentionPrefixRegExp = new RegExp(`^<@!?${this.user.id}>\\s?`);
		this.getOAuthApplication().then(app => {
			this.app = app;
			/**
			 * @event Client#ready
			 * Overridden from the Eris ready event. Functionally the same, but
			 * only emitted after internal setup of the app and
			 * prefixMentionRegExp properties.
			 */
			super.emit('ready', ...args);
		});
		return !!this.listeners(name).length;
	}

	/** Returns the command as a list of parsed strings, or null if it's not a valid command */
	async hasCommand (message: Eris.Message): Promise<[string, string, ...string[]] | null> {
		// Is the message properly prefixed? If not, we can ignore it
		const matchResult = await this.splitPrefixFromContent(message);
		if (!matchResult) return null;

		// It is! We can
		const [prefix, content] = matchResult;
		// If there is no content past the prefix, we don't have a command
		if (!content) {
			// But a lone mention will trigger the default command instead
			if (!prefix || !prefix.match(this.mentionPrefixRegExp!)) return null;
			return [prefix, ''];
		}

		const args = content.split(' ');
		let commandName = args.shift();
		if (commandName === undefined) return null;
		if (!this.caseSensitiveCommands) commandName = commandName.toLowerCase();
		return [prefix, commandName, ...args];
	}

	/**
	 * Given a message, tries to parse a command from it. If it is a command,
	 * executes it and returns `true`; otherwise, returns `false`.
	 */
	async processCommand (msg): Promise<boolean> {
		const commandInfo = await this.hasCommand(msg);
		if (!commandInfo) return false;
		const [prefix, commandName, ...args] = commandInfo;

		const command = this.commandForName(commandName);
		// Construct a full context object now that we have all the info
		const fullContext: CommandContext = Object.assign({
			prefix,
			commandName,
		}, this.eventContext);

		// If the message has command but that command is not found
		if (!command) {
			this.emit('invalidCommand', msg, args, fullContext);
			return false;
		}
		// Do the things
		this.emit('preCommand', command, msg, args, fullContext);
		const executed = await command.execute(msg, args, fullContext);
		if (executed) this.emit('postCommand', command, msg, args, fullContext);
		return true;
	}

	/** Adds things to the context objects the client sends. */
	extendContext (options: object): this {
		Object.assign(this.contextAdditions, options);
		return this;
	}

	/** Set requirements for all commands at once */
	setGlobalRequirements (requirements: CommandRequirements) {
		Object.assign(this.globalCommandRequirements, requirements);
		return this;
	}

	/** Register a command to the client. */
	addCommand (command: Command): this {
		if (!(command instanceof Command)) throw new TypeError('Not a command');
		for (const name of command.names) {
			for (const otherCommand of this.commands) {
				if (otherCommand.names.includes(name)) {
					throw new TypeError(`Two commands have the same name: ${name}`);
				}
			}
		}
		this.commands.push(command);
		this.emit('commandLoaded', command);
		return this;
	}

	/** Register an EventListener class instance to the client. */
	addEvent (eventListener: EventListener): this {
		this.events.push(eventListener);
		this.on(eventListener.args[0], (...args) => {
			eventListener.args[1](...args, this.eventContext);
		});
		return this;
	}

	/** Load the files in a directory and attempt to add a command from each. */
	addDir (dirname: string): this {
		// Synchronous calls are fine with this method because it's only called
		// on init
		// eslint-disable-next-line no-sync
		const filenames = fs.readdirSync(dirname);
		for (const filename of filenames) {
			const filepath = path.resolve(dirname, filename);
			// eslint-disable-next-line no-sync
			const info = fs.statSync(filepath);
			if (info && info.isDirectory()) {
				this.addDir(filepath);
			} else {
				// Add files only if they can be required
				for (const extension of Object.keys(require.extensions)) {
					if (filepath.endsWith(extension)) {
						this.addFile(filepath);
					}
				}
			}
		}
		return this;
	}

	/** Add a command or event exported from a file. */
	// TODO: support exporting multiple components?
	addFile (filename: string): this {
		// Clear require cache so we always get a fresh copy
		delete require.cache[filename];
		// eslint-disable-next-line global-require
		let thing = require(filename);
		if (thing.default) {
			// Use object.assign to preserve other exports
			// TODO: this kinda breaks typescript but it's fine
			thing = Object.assign(thing.default, thing);
			delete thing.default;
		}
		thing.filename = filename;
		if (thing instanceof Command) {
			this.addCommand(thing);
		} else if (thing instanceof EventListener) {
			this.addEvent(thing);
		} else {
			throw new TypeError('Exported value is not a command or event listener');
		}
		return this;
	}

	/**
	 * Set the default command. This command is executed when `allowMention` is
	 * true and the bot is pinged with no command.
	 */
	setDefaultCommand (commandName: string): this {
		const command = this.commandForName(commandName);
		if (!command) throw new TypeError(`No known command matches ${commandName}`);
		this.defaultCommand = command;
		return this;
	}

	/**
	 * Reloads all commands and events that were loaded via from files. Useful
	 * for development to hot-reload components as you work on them.
	 */
	reloadFiles (): this {
		for (const list of [this.commands, this.events]) {
			// Iterate over the lists backwards to avoid overwriting indexes (this
			// rewrites the lists in reverse order, but we don't care)
			let i = list.length;
			while (i--) {
				const thing = list[i];
				if (thing.filename) {
					list.splice(i, 1);
					this.addFile(thing.filename);
				}
			}
		}
		return this;
	}

	/**
	 * Alias for `addDir`.
	 * @deprecated
	 */
	addCommandDir (dirname: string): this {
		return this.addDir(dirname);
	}

	/**
	 * Alias for `addFile`.
	 * @deprecated
	 */
	addCommandFile (filename: string): this {
		return this.addFile(filename);
	}

	/**
	 * Alias for `reloadFiles()`.
	 * @deprecated
	 */
	reloadCommands (): this {
		return this.reloadFiles();
	}

	/**
	 * Checks the list of registered commands and returns one whch is known by a
	 * given name.
	 */
	commandForName (name: string): Command | null {
		if (this.caseSensitiveCommands) return this.commands.find(c => c.names.includes(name)) || null;
		return this.commands.find(c => c.names.some(n => n.toLowerCase() === name.toLowerCase())) || null;
	}

	/**
	 * Registers a function used to determine what prefixes to use on a
	 * per-message basis. Returns a string or an array of strings that should be
	 * recognized as prefixes for the message, or `undefined` to specify that
	 * the default prefix should be used. If the `allowMention` client option is
	 * set, mentions will work regardless of the return value of your custom
	 * function. The empty prefix also always works in private channels.
	 */
	prefixes (func: PrefixFunction): this {
		if (this.prefixFunction) {
			process.emitWarning('Client.prefixes called multiple times');
		}
		this.prefixFunction = func;
		return this;
	}

	async getPrefixesForMessage (msg) {
		// TODO inlining this context creation is bleh
		const prefixes = this.prefixFunction && await this.prefixFunction(msg, this.eventContext);
		if (prefixes == null) {
			// If we have no custom function or it returned nothing, use default
			return [this.prefix];
		}
		// Always return as an array, even if we got a single result back
		return makeArray(prefixes);
	}

	// Takes a message, gets the prefix based on the config of any guild it was
	// sent in, and returns the message's content without the prefix if the
	// prefix matches, and `null` if it doesn't.
	// @param {Eris.Message} msg The message to process
	// @returns {Array<String|null>} An array `[prefix, rest]` if the message
	// matches the prefix, or `[null, null]` if not
	async splitPrefixFromContent (msg: Eris.Message): Promise<[string, string] | null> {
		const prefixes = await this.getPrefixesForMessage(msg);

		// Traditional prefix checking
		for (const prefix of prefixes) {
			if (this.caseSensitivePrefix ? msg.content.startsWith(prefix) : msg.content.toLowerCase().startsWith(prefix.toLowerCase())) {
				return [prefix, msg.content.substr(prefix.length)];
			}
		}
		// Allow mentions to be used as prefixes according to config
		if (this.allowMention) {
			const match = msg.content.match(this.mentionPrefixRegExp!);
			if (match) { // TODO: guild config
				return [match[0], msg.content.substr(match[0].length)];
			}
		}
		// Allow no prefix in direct message channels
		if (!(msg.channel instanceof Eris.GuildChannel)) {
			return ['', msg.content];
		}
		// we got nothing
		return null;
	}

	/** @deprecated Alias of `prefix` */
	get defaultPrefix () {
		return this.prefix;
	}

	set defaultPrefix (val: string) {
		this.prefix = val;
	}
}

export interface ClientEvents<T> extends Eris.ClientEvents<T> {
	/**
	 * @event
	 * Fired when a command is loaded.
	 * @param command The command that was loaded
	 */
	(event: 'commandLoaded', listener: (cmd: Command) => void): T;
	/**
	 * @event
	 * Fired just before a command has its requirements evaluated on an
	 * incoming message.
	 * @param command The command that will be executed
	 * @param message The message that triggered the command
	 * @param args The arguments passed to the command handler
	 * @param context The context object for the command
	 */
	(event: 'preCommand', listener: (cmd: Command, msg: Eris.Message, args: string[], ctx: CommandContext) => void): T;
	/**
	 * @event
	 * Fired after a command is executed.
	 * @param command The command that will be executed
	 * @param message The message that triggered the command
	 * @param args The arguments passed to the command handler
	 * @param context The context object for the command
	 */
	(event: 'postCommand', listener: (cmd: Command, msg: Eris.Message, args: string[], ctx: CommandContext) => void): T;
	/**
	 * @event
	 * Fired if a message starts with a command but no valid command is found
	 * @param command The command that will be executed
	 * @param message The message that triggered the command
	 * @param args The arguments passed to the command handler
	 * @param context The context object for the command
	 */
	(event: 'invalidCommand', listener: (msg: Eris.Message, args: string[], ctx: CommandContext) => void): T;
}

export declare interface Client extends Eris.Client {
	on: ClientEvents<this>;
}
