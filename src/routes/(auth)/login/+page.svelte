<!--
  Sign in — docs/DESIGN.md §4. Passkey first when the browser has one, password
  always available underneath: §3.2 requires a fallback path, and "this phone
  remembers you" is worthless on the phone that does not.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { api, ApiError, OfflineError } from '$lib/client/api';
	import { messageOf } from '$lib/client/app.svelte';
	import { safeNext } from '$lib/client/redirect';
	import { messages } from '$lib/client/i18n';
	import Banner from '$lib/components/Banner.svelte';

	// Signed out there is no member and no `users.locale`, so the root load
	// negotiated `Accept-Language` for this screen (§8.5). That is not a
	// violation of "locale never comes from a header": the rule is about a
	// member's language not depending on the device, and there is no member yet.
	const m = $derived(messages());

	let username = $state('');
	let password = $state('');
	let showPassword = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let passkeySupported = $state(false);

	$effect(() => {
		passkeySupported =
			typeof window !== 'undefined' &&
			typeof window.PublicKeyCredential !== 'undefined' &&
			typeof navigator.credentials?.get === 'function';
	});

	// Only a same-site path is honoured. An absolute URL here would make the
	// sign-in screen an open redirect for anyone who can get a member to open a
	// link — `safeNext` is where that rule and its tests live.
	const next = () => safeNext(page.url.searchParams.get('next'));

	async function afterSignIn(mustChangePassword: boolean) {
		// `goto(..., { invalidateAll: true })`, NOT `invalidateAll()` then `goto`.
		// Invalidating first re-runs this group's layout load with the new session
		// in place, and that load redirects a signed-in visitor away from /login —
		// so the redirect wins the race and `next` is silently ignored, for every
		// target, safe or not.
		await goto(mustChangePassword ? '/password' : next(), {
			replaceState: true,
			invalidateAll: true
		});
	}

	async function signIn(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = null;
		try {
			const body = await api<{ mustChangePassword: boolean }>('/api/auth/login', {
				method: 'POST',
				body: { username, password }
			});
			password = '';
			await afterSignIn(body.mustChangePassword);
		} catch (err) {
			error = messageOf(err);
		} finally {
			busy = false;
		}
	}

	async function signInWithPasskey() {
		if (busy) return;
		busy = true;
		error = null;
		try {
			const { startAuthentication } = await import('@simplewebauthn/browser');
			const begin = await api<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }>(
				'/api/auth/passkey/login/options',
				{ method: 'POST', body: {} }
			);
			const assertion = await startAuthentication({ optionsJSON: begin.options });
			const body = await api<{ user: { mustChangePassword: boolean } }>(
				'/api/auth/passkey/login/verify',
				{ method: 'POST', body: { challengeId: begin.challengeId, response: assertion } }
			);
			await afterSignIn(body.user.mustChangePassword);
		} catch (err) {
			if (err instanceof ApiError || err instanceof OfflineError) error = messageOf(err);
			// Anything else came from the authenticator: the member cancelled the
			// OS prompt, or has no passkey on this device. Neither is an error worth
			// a red banner — the password form is right there.
			else if (err instanceof Error && err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
				error = m.loginPasskeyFailed;
			}
		} finally {
			busy = false;
		}
	}

	type PublicKeyCredentialRequestOptionsJSON = Parameters<
		typeof import('@simplewebauthn/browser').startAuthentication
	>[0]['optionsJSON'];
</script>

<svelte:head><title>{m.loginSubmit} · Zembil</title></svelte:head>

<header>
	<p class="z-eyebrow">Zembil</p>
	<h1 class="z-display">{m.loginTitle}</h1>
</header>

<Banner message={error} />

<form onsubmit={signIn}>
	<label class="sr-only" for="username">{m.loginName}</label>
	<input
		class="z-field"
		id="username"
		name="username"
		placeholder={m.loginName}
		autocomplete="username webauthn"
		autocapitalize="none"
		autocorrect="off"
		spellcheck="false"
		required
		bind:value={username}
	/>

	<label class="sr-only" for="password">{m.loginPassword}</label>
	<div class="password">
		<input
			class="z-field"
			id="password"
			name="password"
			type={showPassword ? 'text' : 'password'}
			placeholder={m.loginPassword}
			autocomplete="current-password"
			required
			bind:value={password}
		/>
		<button
			type="button"
			class="show"
			aria-pressed={showPassword}
			onclick={() => (showPassword = !showPassword)}
		>
			{showPassword ? m.loginHide : m.loginShow}
		</button>
	</div>

	<div class="actions">
		<button class="z-btn" type="submit" disabled={busy || !username || !password}>
			{busy ? m.loginBusy : m.loginSubmit}
		</button>
		{#if passkeySupported}
			<button class="z-btn z-btn--secondary" type="button" disabled={busy} onclick={signInWithPasskey}>
				{m.loginPasskey}
			</button>
		{/if}
	</div>
</form>

<style>
	header {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		/* Everything primary in the bottom third: the fields sit above a spacer
		 * that pushes the buttons down to where a thumb already is. */
		margin-top: auto;
	}

	.password {
		position: relative;
	}

	.show {
		position: absolute;
		inset: 0 6px 0 auto;
		min-width: 60px;
		height: 44px;
		margin: auto 0;
		border-radius: 12px;
		color: var(--text-3);
		font-size: 15px;
		font-weight: 600;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 16px;
	}
</style>
