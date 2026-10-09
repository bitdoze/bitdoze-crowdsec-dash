/**
 * Client-safe channel metadata — field specs drive both the settings form and
 * server-side validation. No server-only imports allowed here.
 */
export type ChannelType = 'smtp' | 'webhook' | 'ntfy' | 'gotify' | 'discord' | 'slack' | 'telegram';

export const CHANNEL_TYPES: ChannelType[] = [
	'smtp',
	'webhook',
	'ntfy',
	'gotify',
	'discord',
	'slack',
	'telegram'
];

export const CHANNEL_FIELDS: Record<
	ChannelType,
	{
		config: { key: string; label: string; required?: boolean }[];
		secrets: { key: string; label: string; required?: boolean }[];
	}
> = {
	webhook: {
		config: [{ key: 'url', label: 'Endpoint URL', required: true }],
		secrets: [{ key: 'token', label: 'Bearer token (optional)' }]
	},
	ntfy: {
		config: [{ key: 'url', label: 'Topic URL (e.g. https://ntfy.sh/my-topic)', required: true }],
		secrets: [{ key: 'token', label: 'Access token (optional)' }]
	},
	gotify: {
		config: [{ key: 'url', label: 'Server URL', required: true }],
		secrets: [{ key: 'token', label: 'App token', required: true }]
	},
	discord: { config: [], secrets: [{ key: 'webhookUrl', label: 'Webhook URL', required: true }] },
	slack: { config: [], secrets: [{ key: 'webhookUrl', label: 'Webhook URL', required: true }] },
	telegram: {
		config: [
			{ key: 'chatId', label: 'Chat ID', required: true },
			{ key: 'apiBase', label: 'API base (optional, default api.telegram.org)' }
		],
		secrets: [{ key: 'token', label: 'Bot token', required: true }]
	},
	smtp: {
		config: [
			{ key: 'host', label: 'SMTP host', required: true },
			{ key: 'port', label: 'Port', required: true },
			{ key: 'secure', label: 'TLS (true/false)' },
			{ key: 'user', label: 'Username (optional)' },
			{ key: 'from', label: 'From address', required: true },
			{ key: 'to', label: 'To address', required: true }
		],
		secrets: [{ key: 'password', label: 'Password (optional)' }]
	}
};
