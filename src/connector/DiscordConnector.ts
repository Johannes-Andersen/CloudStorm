"use strict";

import { EventEmitter } from "events";
import BetterWs from "../structures/BetterWs";
import { GATEWAY_OP_CODES as OP } from "../Constants";
import Intents from "../Intents";

let reconnecting = false;

interface ConnectorEvents {
	queueIdentify: [number];
	event: [import("../Types").IWSMessage];
	ready: [boolean];
	disconnect: [number, string, boolean];
	stateChange: ["connecting" | "identifying" | "resuming" | "ready" | "disconnected"]
}

interface DiscordConnector {
	addListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	emit<E extends keyof ConnectorEvents>(event: E, ...args: ConnectorEvents[E]): boolean;
	eventNames(): Array<keyof ConnectorEvents>;
	listenerCount(event: keyof ConnectorEvents): number;
	listeners(event: keyof ConnectorEvents): Array<(...args: Array<any>) => any>;
	off<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	on<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	once<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	prependListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	prependOnceListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
	rawListeners(event: keyof ConnectorEvents): Array<(...args: Array<any>) => any>;
	removeAllListeners(event?: keyof ConnectorEvents): this;
	removeListener<E extends keyof ConnectorEvents>(event: E, listener: (...args: ConnectorEvents[E]) => any): this;
}

/**
 * Class used for acting based on received events.
 *
 * This class is automatically instantiated by the library and is documented for reference.
 */
class DiscordConnector extends EventEmitter {
	public id: number;
	public client: import("../Client");
	public options: import("../Client")["options"];
	public reconnect: boolean;
	public betterWs: BetterWs;
	public heartbeatTimeout: NodeJS.Timeout | null = null;
	public heartbeatInterval = 0;
	public _trace: string | null = null;
	public seq = 0;
	public status: "connecting" | "identifying" | "resuming" | "ready" | "disconnected" = "disconnected";
	public sessionId: string | null = null;
	public lastACKAt = 0;
	public lastHeartbeatSend = 0;
	public latency = 0;
	private _closing = false;

	public static readonly default = DiscordConnector;

	/**
	 * Create a new Discord Connector.
	 * @param id id of the shard that created this class.
	 * @param client Main client instance.
	 */
	public constructor(id: number, client: import("../Client")) {
		super();

		this.id = id;
		this.client = client;
		this.options = client.options;
		this.reconnect = this.options.reconnect || true;

		this.betterWs = new BetterWs(this.options.endpoint as string, this.options.ws!);

		this.betterWs.on("ws_open", () => {
			this.status = "connecting";
			this.emit("stateChange", "connecting");
			reconnecting = false;
		});
		this.betterWs.on("ws_message", msg => this.messageAction(msg));
		this.betterWs.on("ws_close", (code, reason) => this.handleWsClose(code, reason));
		this.betterWs.on("debug", event => this.client.emit("debug", event));
		this.betterWs.on("debug_send", data => this.client.emit("rawSend", data));
	}

	/**
	 * Connect to Discord.
	 */
	public connect(): Promise<void> {
		this._closing = false;
		this.client.emit("debug", `Shard ${this.id} connecting to gateway`);
		return this.betterWs.connect();
	}

	/**
	 * Close the websocket connection and disconnect.
	 */
	public async disconnect(): Promise<void> {
		this._closing = true;
		return this.betterWs.close(1000, "Disconnected by User");
	}

	/**
	 * Called with a parsed Websocket message to execute further actions.
	 * @param message Message that was received.
	 */
	private async messageAction(message: import("../Types").IGatewayMessage): Promise<void> {
		this.client.emit("rawReceive", message);

		if (message.s) {
			if (message.s > this.seq + 1) {
				this.client.emit("debug", `Shard ${this.id}, invalid sequence: current: ${this.seq} message: ${message.s}`);
				this.seq = message.s;
				this.resume();
			}
			this.seq = message.s;
		}

		switch (message.op) {
		case OP.DISPATCH:
			this.handleDispatch(message);
			break;

		case OP.HEARTBEAT:
			this.heartbeat();
			break;

		case OP.RECONNECT:
			this.client.emit("debug", `Gateway asked shard ${this.id} to reconnect`);
			if (this.options.reconnect) this._reconnect(true);
			else this.disconnect();
			break;

		case OP.INVALID_SESSION:
			if (message.d && this.sessionId) this.resume();
			else {
				this.seq = 0;
				this.sessionId = "";
				this.emit("queueIdentify", this.id);
			}
			break;

		case OP.HELLO:
			this.client.emit("debug", `Shard ${this.id} received HELLO`);
			this.heartbeat();
			this.heartbeatInterval = message.d.heartbeat_interval;
			this.heartbeatTimeout = setInterval(() => {
				if (this.lastACKAt <= Date.now() - (this.heartbeatInterval + 5000)) {
					this.client.emit("debug", `Shard ${this.id} has not received a heartbeat ACK in ${this.heartbeatInterval + 5000}ms.`);
					if (this.options.reconnect) this._reconnect(true);
					else this.disconnect();
				} else this.heartbeat();
			}, this.heartbeatInterval);
			this._trace = message.d._trace;
			this.emit("queueIdentify", this.id);
			break;

		case OP.HEARTBEAT_ACK:
			this.lastACKAt = Date.now();
			this.latency = this.lastACKAt - this.lastHeartbeatSend;
			break;

		default:
			this.emit("event", message);
		}
	}

	/**
	 * Reset this connector to be ready to resume or hard reconnect, then connect.
	 * @param resume Whether or not the client intends to send an OP 6 RESUME later.
	 */
	private async _reconnect(resume = false): Promise<void> {
		if (resume) reconnecting = true;
		if (this.betterWs.status === 2) void this.client.emit("error", `Client was attempting to ${resume ? "resume" : "reconnect"} while the WebSocket was still in the connecting state. This should never happen.`);
		await this.betterWs.close(resume ? 4000 : 1012, "reconnecting");
		if (resume) this.clearHeartBeat();
		else this.reset();
		this.connect();
	}

	/**
	 * Hard reset this connector.
	 */
	private reset(): void {
		this.sessionId = null;
		this.seq = 0;
		this.lastACKAt = 0;
		this._trace = null;
		this.clearHeartBeat();
	}

	/**
	 * Clear the heart beat interval, set it to null and set the cached heartbeat_interval as 0.
	 */
	private clearHeartBeat(): void {
		if (this.heartbeatTimeout) clearInterval(this.heartbeatTimeout);
		this.heartbeatTimeout = null;
		this.heartbeatInterval = 0;
	}

	/**
	 * Send an OP 2 IDENTIFY to the gateway or an OP 6 RESUME if forceful identify is falsy.
	 * @param force Whether CloudStorm should send an OP 2 IDENTIFY even if there's a session that could be resumed.
	 */
	public async identify(force?: boolean): Promise<void> {
		if (this.betterWs.status !== 1) void this.client.emit("debug", "Client was attempting to identify when the ws was not open");
		if (this.sessionId && !force) return this.resume();
		this.client.emit("debug", `Shard ${this.id} is identifying`);

		this.status = "identifying";
		this.emit("stateChange", "identifying");

		const data = {
			op: OP.IDENTIFY,
			d: {
				token: this.options.token,
				properties: {
					$os: process.platform,
					$browser: "CloudStorm",
					$device: "CloudStorm"
				},
				large_threshold: this.options.largeGuildThreshold,
				shard: [this.id, this.options.totalShards || 1],
				intents: this.options.intents ? Intents.resolve(this.options.intents) : 0
			} as import("discord-typings").IdentifyPayload
		};

		if (this.options.initialPresence) Object.assign(data.d, { presence: this._checkPresenceData(this.options.initialPresence) });
		return this.betterWs.sendMessage(data);
	}

	/**
	 * Send an OP 6 RESUME to the gateway.
	 */
	private async resume(): Promise<void> {
		if (this.betterWs.status !== 1) void this.client.emit("debug", "Client was attempting to resume when the ws was not open");
		this.client.emit("debug", `Shard ${this.id} is resuming`);
		this.status = "resuming";
		this.emit("stateChange", "resuming");
		return this.betterWs.sendMessage({
			op: OP.RESUME,
			d: { seq: this.seq, token: this.options.token, session_id: this.sessionId }
		});
	}

	/**
	 * Send an OP 1 HEARTBEAT to the gateway.
	 */
	private heartbeat(): void {
		if (this.betterWs.status !== 1) void this.client.emit("debug", "Client was attempting to heartbeat when the ws was not open");
		this.betterWs.sendMessage({ op: OP.HEARTBEAT, d: this.seq });
		this.lastHeartbeatSend = Date.now();
	}

	/**
	 * Handle dispatch events.
	 * @param message Message received from the websocket.
	 */
	private handleDispatch(message: import("../Types").IGatewayMessage): void {
		switch (message.t) {
		case "READY":
		case "RESUMED":
			if (message.t === "READY") this.sessionId = message.d.session_id;
			this.status = "ready";
			this.emit("stateChange", "ready");
			this._trace = message.d._trace;
			this.emit("ready", message.t === "RESUMED");
			this.emit("event", message);
			break;
		default:
			this.emit("event", message);
		}
	}

	/**
	 * Handle a close from the underlying websocket.
	 * @param code Websocket close code.
	 * @param reason Close reason if any.
	 */
	private handleWsClose(code: number, reason: string): void {
		let gracefulClose = false;
		this.status = "disconnected";
		this.emit("stateChange", "disconnected");

		// Disallowed Intents.
		if (code === 4014) this.client.emit("error", "Disallowed Intents, check your client options and application page.");

		// Invalid Intents.
		if (code === 4013) this.client.emit("error", "Invalid Intents data, check your client options.");

		// Invalid API version.
		if (code === 4012) this.client.emit("error", "Invalid API version.");

		// Sharding required.
		if (code === 4011) this.client.emit("error", "Shard would be on over 2500 guilds. Add more shards.");

		// Invalid shard.
		if (code === 4010) this.client.emit("error", "Invalid sharding data, check your client options.");

		// Session timed out.
		// force identify if the session is marked as invalid.
		if (code === 4009) {
			this.client.emit("error", "Session timed out.");
			this.clearHeartBeat();
			this.connect();
		}

		// Rate limited.
		if (code === 4008) {
			this.client.emit("error", "You are being rate limited. Wait before sending more packets.");
			this.clearHeartBeat();
			this.connect();
		}

		// Invalid sequence.
		if (code === 4007) {
			this.client.emit("error", "Invalid sequence. Reconnecting and starting a new session.");
			this.reset();
			this.connect();
		}

		// Already authenticated.
		if (code === 4005) {
			this.client.emit("error", "You sent more than one OP 2 IDENTIFY payload while the websocket was open.");
			this.clearHeartBeat();
			this.connect();
		}

		// Authentication failed.
		if (code === 4004) this.client.emit("error", "Tried to connect with an invalid token");

		// Not authenticated.
		if (code === 4003) {
			this.client.emit("error", "You tried to send a packet before sending an OP 2 IDENTIFY or OP 6 RESUME.");
			this.clearHeartBeat();
			this.connect();
		}

		// Decode error.
		if (code === 4002) {
			this.client.emit("error", "You sent an invalid payload");
			this.clearHeartBeat();
			this.connect();
		}

		// Invalid opcode.
		if (code === 4001) {
			this.client.emit("error", "You sent an invalid opcode or invalid payload for an opcode");
			this.clearHeartBeat();
			this.connect();
		}

		// Generic error / safe self closing code.
		if (code === 4000) {
			if (reconnecting) gracefulClose = true;
			else {
				this.client.emit("error", "Error code 4000 received. Attempting to resume");
				this.clearHeartBeat();
				this.connect();
			}
		}

		// Don't try to reconnect when true
		if (code === 1000 && this._closing) gracefulClose = true;
		this._closing = false;

		if (gracefulClose) this.clearHeartBeat();
		this.emit("disconnect", code, reason, gracefulClose);
	}

	/**
	 * Send an OP 3 PRESENCE_UPDATE to the gateway.
	 * @param data Presence data to send.
	 */
	public async presenceUpdate(data: import("discord-typings").GatewayPresenceUpdate): Promise<void> {
		return this.betterWs.sendMessage({ op: OP.PRESENCE_UPDATE, d: this._checkPresenceData(data) });
	}

	/**
	 * Send an OP 4 VOICE_STATE_UPDATE to the gateway.
	 * @param data Voice state update data to send.
	 */
	public async voiceStateUpdate(data: import("discord-typings").VoiceStateUpdatePayload & { self_deaf?: boolean; self_mute?: boolean; }): Promise<void> {
		if (!data) return Promise.resolve();
		return this.betterWs.sendMessage({ op: OP.VOICE_STATE_UPDATE, d: this._checkVoiceStateUpdateData(data) });
	}

	/**
	 * Send an OP 8 REQUEST_GUILD_MEMBERS to the gateway.
	 * @param data Data to send.
	 */
	public async requestGuildMembers(data: import("discord-typings").GuildRequestMembersPayload & { limit?: number; }): Promise<void> {
		return this.betterWs.sendMessage({ op: OP.REQUEST_GUILD_MEMBERS, d: this._checkRequestGuildMembersData(data) });
	}

	/**
	 * Checks presence data and fills in missing elements.
	 * @param data Data to send.
	 * @returns Data after it's fixed/checked.
	 */
	private _checkPresenceData(data: import("discord-typings").GatewayPresenceUpdate): import("discord-typings").GatewayPresenceUpdate {
		data.status = data.status || "online";
		data.activities = data.activities && Array.isArray(data.activities) ? data.activities : [];

		if (data.activities) {
			for (const activity of data.activities) {
				const index = data.activities.indexOf(activity);
				if (activity.type === undefined) activity.type = activity.url ? 1 : 0;
				if (!activity.name) data.activities.splice(index, 1);
			}
		}

		data.afk = data.afk || false;
		data.since = data.since || Date.now();
		return data;
	}

	/**
	 * Checks voice state update data and fills in missing elements.
	 * @param data Data to send.
	 * @returns Data after it's fixed/checked.
	 */
	private _checkVoiceStateUpdateData(data: import("discord-typings").VoiceStateUpdatePayload & { self_deaf?: boolean; self_mute?: boolean; }): import("discord-typings").VoiceStateUpdatePayload {
		data.channel_id = data.channel_id || null;
		data.self_mute = data.self_mute || false;
		data.self_deaf = data.self_deaf || false;
		return data;
	}

	/**
	 * Checks request guild members data and fills in missing elements.
	 * @param data Data to send.
	 * @returns Data after it's fixed/checked.
	 */
	private _checkRequestGuildMembersData(data: import("discord-typings").GuildRequestMembersPayload & { limit?: number; }) {
		data.query = data.query || "";
		data.limit = data.limit || 0;
		return data;
	}
}

export = DiscordConnector;
