/**
 * Vision Delegation — Client half.
 *
 * Pasted or picked images are converted, in place, into generic FILE
 * attachments before they can ride a prompt as image parts (the only form
 * the Host rejects for text-only models). The main model then receives the
 * harness's standard file handle — "[File pasted-image.png saved at <path>:
 * read it with your file tools when needed]" — and stays fully in charge:
 * it formulates its own question and calls its vision tool (e.g.
 * glm-5.3-flash) on the saved path, exactly like any other agentic
 * delegation. No model switching, nothing to restore, no race with the
 * send.
 */
window.__ModuleLoader__.load({
	id: 'dsh-vision-delegation',
	factory(require) {
		const React = require('react');
		/** Small status pill under the composer: visible iff this plugin is armed. */
		const ArmedBadge = () => React.createElement('span', {
			style: {
				display: 'inline-flex', alignItems: 'center', gap: '4px',
				padding: '1px 8px', borderRadius: '999px',
				fontSize: '11px', lineHeight: '16px',
				color: 'var(--dsw-alias-label-caption, inherit)',
				background: 'var(--dsw-alias-interactive-bg-hover, transparent)',
				pointerEvents: 'none', userSelect: 'none'
			},
			title: 'vision delegation is active: pasted images become file attachments the model inspects through its vision tool'
		}, '👁 vision delegation');
		const TAG = '[vision-delegation]';

		const log = (...args) => { try { console.log(TAG, ...args); } catch {} };
		const warn = (...args) => { try { console.warn(TAG, ...args); } catch {} };

		/** A non-image browser MIME, so the intake classifies the copy as a file draft. */
		const FILE_MIME = 'application/octet-stream';
		const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;

		const fallbackName = () => {
			const stamp = new Date();
			const pad = (n) => String(n).padStart(2, '0');
			return `pasted-image-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;
		};

		return {
			inject: ['uiSession', 'conversation', 'slots'],
			apply(ctx) {
				log('client half active: pasted images become file attachments for vision delegation');

				// Armed indicator under the composer: visible proof of activation.
				ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
					name: 'conversation.composer.dock', id: 'vision-delegation', order: 9999,
				}, ArmedBadge));

				let watchedSessionId;
				let unsubscribeInput = null;
				let converting = false;
				let reportedMissingHook = false;

				/** Convert every image draft in the active composer into a file draft. */
				const convert = (sessionId) => {
					if (converting) return;
					const binding = ctx.uiSession.adapter.current.getSnapshot();
					if (binding == null || binding.key !== sessionId) return;
					const inputHook = binding.hooks?.input;
					const actions = binding.props?.inputActions;
					if (inputHook == null || actions == null) return;
					const snap = inputHook.getSnapshot();
					if (snap == null || snap.phase !== 'plain') return;

					const ids = snap.attachmentIds ?? [];
					if (ids.length === 0) return;
					let drafts;
					try {
						drafts = ctx.conversation.resolveDraftAttachments(ids);
					} catch (error) {
						warn('resolveDraftAttachments failed:', error);
						return;
					}
					const images = drafts.filter((draft) => draft?.kind === 'image');
					if (images.length === 0) return;

					converting = true;
					try {
						// Re-wrap each image with a generic MIME so the intake's own
						// classifier routes the copy to the file-draft path; the bytes
						// and a meaningful image name are preserved.
						const wrapped = images.map((draft) => {
							const original = draft.file?.name ?? '';
							const name = IMAGE_EXTENSION.test(original) ? original : fallbackName();
							return new File([draft.file], name, { type: FILE_MIME });
						});
						let created;
						try {
							created = ctx.conversation.createDrafts(sessionId, wrapped);
						} catch (error) {
							warn('createDrafts failed:', error?.message ?? error);
							return;
						}
						const newIds = created.map((draft) => draft.id);
						if (!actions.addAttachments(newIds)) {
							warn('draft admission locked; image left as-is');
							for (const draft of created) ctx.conversation.releaseDraftAttachment(draft.id);
							return;
						}
						for (const image of images) ctx.conversation.releaseDraftAttachment(image.id);
						log(`converted ${images.length} pasted image(s) into file attachments; the model will inspect them through its vision tool`);
					} finally {
						converting = false;
					}
				};

				/** Follow the main session binding and its per-session input store. */
				const watchInput = () => {
					const binding = ctx.uiSession.adapter.current.getSnapshot();
					const sessionId = binding?.key;
					const inputHook = binding?.hooks?.input;
					if (sessionId == null || inputHook == null) {
						if (sessionId != null && inputHook == null && !reportedMissingHook) {
							reportedMissingHook = true;
							warn('session binding exposes no "input" hook; composer watch impossible (UI contract changed?)');
						}
						if (watchedSessionId !== undefined) {
							watchedSessionId = undefined;
							unsubscribeInput?.();
							unsubscribeInput = null;
						}
						return;
					}
					if (sessionId === watchedSessionId) return;
					watchedSessionId = sessionId;
					unsubscribeInput?.();
					log('watching composer of session', String(sessionId));
					unsubscribeInput = inputHook.subscribe(() => convert(sessionId));
					convert(sessionId);
				};

				const unsubscribeBinding = ctx.uiSession.adapter.current.subscribe(watchInput);
				watchInput();

				return () => {
					unsubscribeBinding();
					unsubscribeInput?.();
				};
			},
		};
	},
});
