<!-- Account — docs/DESIGN.md §4. -->
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/client/api';
	import { forgetLists, messageOf } from '$lib/client/app.svelte';
	import { applyTheme } from '$lib/client/theme';
	import { longDate, relative } from '$lib/client/time';
	import { messages } from '$lib/client/i18n';
	import { displayVersion, releasedAt } from '$lib/version';
	import { LANGUAGE_NAMES } from '$lib/i18n';
	import { disablePush, enablePush, readPushState, type PushState } from '$lib/client/push';
	import { LOCALES, THEMES, type Locale, type Passkey, type Theme, type User } from '$lib/types';
	import Banner from '$lib/components/Banner.svelte';
	import Sheet from '$lib/components/Sheet.svelte';

	let { data } = $props();

	const m = $derived(messages());

	// Null until this page has fetched for itself; until then the load's copy is
	// the truth, so a navigation back here does not flash an empty list.
	let fetched = $state<Passkey[] | null>(null);
	let passkeys = $derived(fetched ?? data.passkeys);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let passkeySupported = $state(false);

	$effect(() => {
		passkeySupported =
			typeof window !== 'undefined' &&
			typeof window.PublicKeyCredential !== 'undefined' &&
			typeof navigator.credentials?.create === 'function';
	});

	async function refresh() {
		const body = await api<{ passkeys: Passkey[] }>('/api/me');
		fetched = body.passkeys;
	}

	// ---- passkeys ---------------------------------------------------------
	let naming = $state(false);
	let label = $state('');

	function suggestLabel(): string {
		const ua = navigator.userAgent;
		if (/iPhone/.test(ua)) return 'iPhone';
		if (/iPad/.test(ua)) return 'iPad';
		if (/Android/.test(ua)) return 'Android phone';
		if (/Mac OS X/.test(ua)) return 'Mac';
		if (/Windows/.test(ua)) return 'Windows PC';
		return 'This device';
	}

	function openNaming() {
		label = suggestLabel();
		error = null;
		naming = true;
	}

	async function addPasskey(event: SubmitEvent) {
		event.preventDefault();
		if (busy || label.trim().length === 0) return;
		busy = true;
		error = null;
		try {
			const { startRegistration } = await import('@simplewebauthn/browser');
			const begin = await api<{ options: RegistrationOptions; challengeId: string }>(
				'/api/auth/passkey/register/options',
				{ method: 'POST', body: {} }
			);
			const attestation = await startRegistration({ optionsJSON: begin.options });
			await api('/api/auth/passkey/register/verify', {
				method: 'POST',
				body: { challengeId: begin.challengeId, response: attestation, label: label.trim() }
			});
			naming = false;
			await refresh();
		} catch (err) {
			if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
				// The member dismissed the OS prompt. Not an error.
				naming = false;
			} else if (err instanceof Error && err.name === 'InvalidStateError') {
				error = m.youPasskeyExists;
			} else {
				// A SecurityError here almost always means ZEMBIL_RP_ID does not match
				// the host the browser is on — a deployment mistake, not a member's.
				// The name goes to the console because the member cannot act on it and
				// the operator can.
				console.error('[zembil] passkey registration failed', err);
				error = messageOf(err);
			}
		} finally {
			busy = false;
		}
	}

	async function removePasskey(passkey: Passkey) {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await api(`/api/auth/passkey/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
			await refresh();
		} catch (err) {
			error = messageOf(err);
		} finally {
			busy = false;
		}
	}

	// ---- language (§8.5) ----------------------------------------------------
	// The column is the single source, and it is the server's copy that matters:
	// push text is composed there, for a recipient who is not the person who
	// triggered it, so it cannot be translated by the phone that displays it.
	let localeBusy = $state(false);

	async function chooseLocale(next: Locale) {
		if (localeBusy || next === data.user.locale) return;
		localeBusy = true;
		error = null;
		try {
			await api<{ user: User }>('/api/me', { method: 'PATCH', body: { locale: next } });
			// `invalidateAll` re-runs the root load, which is what carries `locale`
			// in page data — so every string on screen re-renders from the new
			// catalogue without this component knowing which ones they are.
			await invalidateAll();
		} catch (err) {
			error = messageOf(err);
		} finally {
			localeBusy = false;
		}
	}

	// ---- theme (§10.1) ------------------------------------------------------
	// A dropdown rather than a segmented row, because eight options do not fit
	// across a 390px phone and a native <select> gets the platform's own picker
	// — a wheel on iOS, a sheet on Android — which is bigger than any 44px
	// target we could draw and already knows about VoiceOver.
	//
	// The column is the source, so the flow is: PATCH, then `invalidateAll`,
	// which re-runs the root load and re-applies the attribute from page data.
	// `applyTheme` here is not a duplicate of that — it repaints on the tap
	// rather than after the round trip, so the picker feels like a switch and
	// not like a form.
	let themeBusy = $state(false);

	const THEME_LABELS: Record<Theme, () => string> = {
		auto: () => m.themeAuto,
		light: () => m.themeLight,
		dark: () => m.themeDark,
		sepia: () => m.themeSepia,
		sage: () => m.themeSage,
		contrast: () => m.themeContrast,
		indigo: () => m.themeIndigo,
		plum: () => m.themePlum
	};

	async function chooseTheme(next: Theme) {
		if (themeBusy || next === data.user.theme) return;
		const previous = data.user.theme;
		themeBusy = true;
		error = null;
		applyTheme(next);
		try {
			await api<{ user: User }>('/api/me', { method: 'PATCH', body: { theme: next } });
			await invalidateAll();
		} catch (err) {
			// The optimistic repaint has to be undone by hand: nothing re-rendered,
			// so there is no load to fall back to.
			applyTheme(previous);
			error = messageOf(err);
		} finally {
			themeBusy = false;
		}
	}

	// ---- notifications (§8.7) -----------------------------------------------
	let push = $state<PushState | null>(null);
	let pushBusy = $state(false);
	let pushDismissed = $state(false);

	$effect(() => {
		void loadPushState();
	});

	async function loadPushState() {
		try {
			push = await readPushState();
		} catch {
			// A failure to READ the push state is not worth a banner over the whole
			// account screen; the section simply does not appear.
			push = null;
		}
	}

	async function togglePush() {
		if (pushBusy || !push) return;
		pushBusy = true;
		error = null;
		pushDismissed = false;
		try {
			if (push.subscribed) {
				await disablePush();
			} else {
				// `false` means the member dismissed the OS prompt. That is an
				// answer, not a failure, and it must not be shown as one.
				pushDismissed = !(await enablePush());
			}
			await loadPushState();
		} catch (err) {
			error = messageOf(err);
		} finally {
			pushBusy = false;
		}
	}

	// ---- sign out ---------------------------------------------------------
	async function signOut() {
		if (busy) return;
		busy = true;
		try {
			await api('/api/auth/logout', { method: 'POST', body: {} });
		} catch {
			// Even if the request failed, leaving the signed-in shell up is worse
			// than navigating away; the cookie is either gone or expired anyway.
		} finally {
			// Cached lists belong to the member who just left.
			forgetLists();
			await invalidateAll();
			await goto('/login', { replaceState: true });
		}
	}

	type RegistrationOptions = Parameters<
		typeof import('@simplewebauthn/browser').startRegistration
	>[0]['optionsJSON'];
</script>

<svelte:head><title>{m.youTitle} · Zembil</title></svelte:head>

<header>
	<p class="z-eyebrow">{m.youEyebrow}</p>
	<h1 class="z-title">{data.user.displayName}</h1>
	<p class="z-meta">{data.user.username}{data.user.isAdmin ? ` · ${m.youAdmin}` : ''}</p>
</header>

<div class="body">
	<Banner message={error} />

	<section class="z-panel">
		<h2 class="z-card-title">{m.youPasskeys}</h2>
		<p class="z-meta">{m.youPasskeysBody}</p>
		{#if passkeys.length === 0}
			<p class="z-meta faint">{m.youPasskeysNone}</p>
		{:else}
			<ul>
				{#each passkeys as passkey (passkey.id)}
					<li>
						<span class="grow">
							<span class="label">{passkey.deviceLabel}</span>
							<span class="z-meta">{m.youPasskeyUsed(relative(passkey.lastUsedAt))}</span>
						</span>
						<button type="button" class="remove" disabled={busy} onclick={() => removePasskey(passkey)}>
							{m.youPasskeyRemove}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		{#if passkeySupported}
			<button class="z-btn z-btn--tertiary" type="button" disabled={busy} onclick={openNaming}>
				{m.youPasskeyAdd}
			</button>
		{:else}
			<p class="z-meta faint">{m.youPasskeyUnsupported}</p>
		{/if}
	</section>

	<!-- §8.7. The section is absent entirely when the operator has push switched
	     off, rather than showing a control that would 503. -->
	{#if push && !push.disabledOnServer}
		<section class="z-panel">
			<h2 class="z-card-title">{m.pushTitle}</h2>
			<p class="z-meta">{m.pushBody}</p>

			{#if push.blocker === 'ios-home-screen'}
				<!-- The most likely outcome on this app's primary target, and the one
				     that looks like a broken button if it is not explained. -->
				<p class="z-meta faint">{m.pushIosHomeScreen}</p>
			{:else if push.blocker === 'denied'}
				<p class="z-meta faint">{m.pushDenied}</p>
			{:else if push.blocker === 'unsupported'}
				<p class="z-meta faint">{m.pushUnsupported}</p>
			{:else}
				<p class="z-meta faint">{push.subscribed ? m.pushOn : m.pushOff}</p>
				{#if push.deviceCount > 0}
					<p class="z-meta faint">{m.pushDevices(push.deviceCount)}</p>
				{/if}
				{#if pushDismissed}
					<p class="z-meta faint">{m.pushDismissed}</p>
				{/if}
				<button
					class="z-btn z-btn--tertiary"
					type="button"
					disabled={pushBusy}
					onclick={togglePush}
				>
					{push.subscribed ? m.pushDisable : m.pushEnable}
				</button>
			{/if}
		</section>
	{/if}

	<section class="z-panel">
		<h2 class="z-card-title">{m.youLanguage}</h2>
		<!-- Each language names itself in itself: somebody who has landed in a
		     language they do not read has to be able to find their way out. -->
		<div class="segmented" role="group" aria-label={m.youLanguage}>
			{#each LOCALES as option (option)}
				<button
					type="button"
					class:on={data.user.locale === option}
					aria-pressed={data.user.locale === option}
					disabled={localeBusy}
					lang={option}
					onclick={() => chooseLocale(option)}
				>
					{LANGUAGE_NAMES[option]}
				</button>
			{/each}
		</div>
		{#if localeBusy}<p class="z-meta faint">{m.youLanguageBusy}</p>{/if}
	</section>

	<section class="z-panel">
		<h2 class="z-card-title">{m.youTheme}</h2>
		<label class="sr-only" for="theme">{m.youTheme}</label>
		<select
			class="z-field theme-select"
			id="theme"
			disabled={themeBusy}
			value={data.user.theme}
			onchange={(event) => chooseTheme(event.currentTarget.value as Theme)}
		>
			{#each THEMES as option (option)}
				<option value={option}>{THEME_LABELS[option]()}</option>
			{/each}
		</select>
		<p class="z-meta faint">{themeBusy ? m.youThemeBusy : m.youThemeHelp}</p>
	</section>

	{#if data.user.isAdmin}
		<a class="z-btn z-btn--secondary" href="/you/admin">{m.youManage}</a>
	{/if}

	<button class="z-btn z-btn--tertiary" type="button" disabled={busy} onclick={signOut}>
		{m.youSignOut}
	</button>

	<!--
	  The version, small and last (§11.1).

	  Here and nowhere else: this screen is behind the session, so the build is
	  told only to the family. `GET /api/health` deliberately reports no version
	  (§3.8) and the sign-in screen deliberately shows none, because both are
	  reachable by anyone who finds the hostname and a version string there is a
	  free fingerprint for picking a matching CVE.

	  `<footer>` rather than another `.z-panel`: it is not a setting, nothing in
	  it can be tapped, and it should read as the bottom of the page.
	-->
	<footer class="version">
		{m.youVersion(displayVersion(), longDate(releasedAt(), data.locale))}
	</footer>
</div>

<Sheet open={naming} title={m.youPasskeyNameTitle} onclose={() => (naming = false)}>
	<Banner message={error} />
	<form onsubmit={addPasskey}>
		<label class="sr-only" for="passkey-label">{m.youPasskeyNameLabel}</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input class="z-field" id="passkey-label" maxlength="64" autofocus bind:value={label} />
		<button class="z-btn" type="submit" disabled={busy || label.trim().length === 0}>
			{busy ? m.youPasskeyWaiting : m.youPasskeyCreate}
		</button>
	</form>
</Sheet>

<style>
	header {
		padding: 28px 24px 12px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.body {
		padding: 0 20px 32px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 56px;
		border-top: 1px solid var(--rule);
	}

	.grow {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.label {
		font-size: 17px;
		font-weight: 600;
	}

	.remove {
		flex: none;
		height: 44px;
		padding: 0 14px;
		border-radius: 12px;
		color: var(--danger);
		font-size: 15px;
		font-weight: 700;
	}

	.version {
		/* Below the type scale's smallest role on purpose: it is a fact somebody
		 * looks for, never one they read on the way past. */
		padding: 4px 0 2px;
		color: var(--text-faint);
		font-size: 11px;
		letter-spacing: 0.02em;
		text-align: center;
		/* It sits under the last button, and the account screen already carries
		 * the safe-area padding on its container — so nothing here needs to know
		 * about the home indicator. */
	}

	.faint {
		color: var(--text-faint);
	}

	/* `.z-field` is written for inputs; a <select> additionally needs its native
	 * chevron replaced, because the platform one is drawn in the OS's own colour
	 * and vanishes against the darker themes. Two background gradients meeting
	 * at a corner draw it in a token colour instead — a <select> cannot carry a
	 * pseudo-element, and this needs no extra request. */
	.theme-select {
		appearance: none;
		padding-right: 46px;
		background-image:
			linear-gradient(45deg, transparent 50%, var(--text-3) 50%),
			linear-gradient(135deg, var(--text-3) 50%, transparent 50%);
		background-position:
			right 24px center,
			right 18px center;
		background-size:
			6px 6px,
			6px 6px;
		background-repeat: no-repeat;
	}

	.theme-select:disabled {
		color: var(--text-disabled);
	}

	.segmented {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
		padding: 6px;
		border-radius: 16px;
		background: var(--surface-muted);
	}

	.segmented button {
		height: 44px;
		/* "Türkçe" and "Deutsch" are wider than "Auto"; the row must wrap its
		   glyphs rather than its layout. */
		min-width: 0;
		padding: 0 6px;
		border-radius: 12px;
		font-size: 15px;
		font-weight: 600;
		color: var(--text-2);
	}

	.segmented button.on {
		background: var(--surface);
		color: var(--text);
		font-weight: 700;
	}

	a.z-btn {
		text-decoration: none;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
