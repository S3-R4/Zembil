<!-- Account — docs/DESIGN.md §4. -->
<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { api } from '$lib/client/api';
	import { forgetLists, messageOf } from '$lib/client/app.svelte';
	import { readAppearance, saveAppearance, type Appearance } from '$lib/client/theme';
	import { relative } from '$lib/client/time';
	import type { Passkey } from '$lib/types';
	import Banner from '$lib/components/Banner.svelte';
	import Sheet from '$lib/components/Sheet.svelte';

	let { data } = $props();

	// Null until this page has fetched for itself; until then the load's copy is
	// the truth, so a navigation back here does not flash an empty list.
	let fetched = $state<Passkey[] | null>(null);
	let passkeys = $derived(fetched ?? data.passkeys);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let appearance = $state<Appearance>('auto');
	let passkeySupported = $state(false);

	$effect(() => {
		appearance = readAppearance();
		passkeySupported =
			typeof window !== 'undefined' &&
			typeof window.PublicKeyCredential !== 'undefined' &&
			typeof navigator.credentials?.create === 'function';
	});

	function choose(value: Appearance) {
		appearance = value;
		saveAppearance(value);
	}

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
				error = 'This device already has a passkey for your account.';
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

<svelte:head><title>You · Zembil</title></svelte:head>

<header>
	<p class="z-eyebrow">Signed in as</p>
	<h1 class="z-title">{data.user.displayName}</h1>
	<p class="z-meta">{data.user.username}{data.user.isAdmin ? ' · admin' : ''}</p>
</header>

<div class="body">
	<Banner message={error} />

	<section class="z-card">
		<h2 class="z-card-title">Passkeys</h2>
		<p class="z-meta">Sign in with your face, fingerprint or device PIN instead of a password.</p>
		{#if passkeys.length === 0}
			<p class="z-meta faint">None on this account yet.</p>
		{:else}
			<ul>
				{#each passkeys as passkey (passkey.id)}
					<li>
						<span class="grow">
							<span class="label">{passkey.deviceLabel}</span>
							<span class="z-meta">Used {relative(passkey.lastUsedAt)}</span>
						</span>
						<button type="button" class="remove" disabled={busy} onclick={() => removePasskey(passkey)}>
							Remove
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		{#if passkeySupported}
			<button class="z-btn z-btn--tertiary" type="button" disabled={busy} onclick={openNaming}>
				Add a passkey
			</button>
		{:else}
			<p class="z-meta faint">This browser cannot use passkeys.</p>
		{/if}
	</section>

	<section class="z-card">
		<h2 class="z-card-title">Appearance</h2>
		<div class="segmented" role="group" aria-label="Appearance">
			{#each ['light', 'auto', 'dark'] as const as option (option)}
				<button
					type="button"
					class:on={appearance === option}
					aria-pressed={appearance === option}
					onclick={() => choose(option)}
				>
					{option[0].toUpperCase() + option.slice(1)}
				</button>
			{/each}
		</div>
	</section>

	{#if data.user.isAdmin}
		<a class="z-btn z-btn--secondary" href="/you/admin">Manage the family</a>
	{/if}

	<button class="z-btn z-btn--tertiary" type="button" disabled={busy} onclick={signOut}>
		Sign out
	</button>
</div>

<Sheet open={naming} title="Name this device" onclose={() => (naming = false)}>
	<Banner message={error} />
	<form onsubmit={addPasskey}>
		<label class="sr-only" for="passkey-label">Device name</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input class="z-field" id="passkey-label" maxlength="64" autofocus bind:value={label} />
		<button class="z-btn" type="submit" disabled={busy || label.trim().length === 0}>
			{busy ? 'Waiting for your device…' : 'Create passkey'}
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

	.faint {
		color: var(--text-faint);
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
