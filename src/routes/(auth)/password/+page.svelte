<!--
  The forced password change — CONTRACT.md §3.2. A member arrives here because
  `must_change_password` is set, and the server blocks every other API endpoint
  until it is cleared, so this screen is not a suggestion.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { api } from '$lib/client/api';
	import { messageOf } from '$lib/client/app.svelte';
	import { messages } from '$lib/client/i18n';
	import Banner from '$lib/components/Banner.svelte';

	let { data } = $props();

	// §8.5: `PATCH /api/me` shares a route id with `GET /api/me` and is therefore
	// in PASSWORD_GATE_EXEMPT, so a member who must change their password can
	// still change their language. That is deliberate — this screen has to be
	// readable before it can be obeyed.
	const m = $derived(messages());

	let currentPassword = $state('');
	let newPassword = $state('');
	let confirm = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	const MIN = 12;
	let tooShort = $derived(newPassword.length > 0 && newPassword.length < MIN);
	let mismatch = $derived(confirm.length > 0 && confirm !== newPassword);
	let ready = $derived(
		currentPassword.length > 0 && newPassword.length >= MIN && confirm === newPassword
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (busy || !ready) return;
		busy = true;
		error = null;
		try {
			await api('/api/auth/password', {
				method: 'POST',
				body: { currentPassword, newPassword }
			});
			currentPassword = newPassword = confirm = '';
			// Same ordering rule as the sign-in screen: navigate and invalidate in
			// one step, so the guard for the group we are leaving cannot redirect
			// us somewhere else first.
			await goto('/', { replaceState: true, invalidateAll: true });
		} catch (err) {
			error = messageOf(err);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{m.pwTitle} · Zembil</title></svelte:head>

<header>
	<p class="z-eyebrow">{data.user?.displayName ?? 'Zembil'}</p>
	<h1 class="z-display">{m.pwTitle}</h1>
	<p class="z-meta">{m.pwBody(MIN)}</p>
</header>

<Banner message={error} />

<form onsubmit={submit}>
	<label class="sr-only" for="current">{m.pwCurrent}</label>
	<input
		class="z-field"
		id="current"
		type="password"
		placeholder={m.pwCurrent}
		autocomplete="current-password"
		required
		bind:value={currentPassword}
	/>

	<label class="sr-only" for="next">{m.pwNew}</label>
	<input
		class="z-field"
		id="next"
		type="password"
		placeholder={m.pwNew}
		autocomplete="new-password"
		required
		bind:value={newPassword}
	/>
	{#if tooShort}<p class="hint">{m.pwMore(MIN - newPassword.length)}</p>{/if}

	<label class="sr-only" for="confirm">{m.pwRepeat}</label>
	<input
		class="z-field"
		id="confirm"
		type="password"
		placeholder={m.pwRepeat}
		autocomplete="new-password"
		required
		bind:value={confirm}
	/>
	{#if mismatch}<p class="hint">{m.pwMismatch}</p>{/if}

	<button class="z-btn" type="submit" disabled={busy || !ready}>
		{busy ? m.saving : m.pwSubmit}
	</button>
</form>

<style>
	header {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	header .z-meta {
		margin-top: 4px;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: auto;
	}

	form :global(.z-btn) {
		margin-top: 16px;
	}

	.hint {
		margin: -4px 4px 0;
		font-size: 14px;
		color: var(--text-3);
	}
</style>
