<!--
  The error page. Shows what the server said (§3.1 writes `message` for a
  person), not a substitute of our own — a member who followed a link to a store
  that was archived should read "Store not found", not "Internal Error".
-->
<script lang="ts">
	import { page } from '$app/state';
	import { messages } from '$lib/client/i18n';

	// The error page can render before any `load` has produced page data, so
	// `messages()` falls back to English there. That is the only place in the app
	// where the fallback is reachable, and an untranslated error page is a better
	// outcome than a blank one.
	const m = $derived(messages());

	let code = $derived(page.error?.code ?? '');
	let offline = $derived(code === 'OFFLINE');
	let title = $derived(
		offline
			? m.errOfflineTitle
			: page.status === 404
				? m.errNotFound
				: page.status === 403
					? m.errForbidden
					: page.status === 401
						? m.errUnauthorized
						: m.errUnknown
	);
</script>

<svelte:head><title>{title} · Zembil</title></svelte:head>

<main>
	<div>
		<h1 class="z-display">{title}</h1>
		<!-- The server's own message (§3.1), never a substitute of ours. Only the
		     fallback for "no message at all" comes from the catalogue. -->
		<p class="z-meta">{page.error?.message ?? m.errTryAgain}</p>
	</div>
	<div class="actions">
		{#if offline || page.status >= 500}
			<button class="z-btn" type="button" onclick={() => location.reload()}>{m.retry}</button>
		{/if}
		{#if page.status === 401}
			<a class="z-btn" href="/login">{m.errSignIn}</a>
		{:else}
			<a class="z-btn z-btn--secondary" href="/">{m.errBack}</a>
		{/if}
	</div>
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: 24px;
		min-height: 100dvh;
		padding: 32px 24px calc(32px + env(safe-area-inset-bottom));
	}

	main > div:first-child {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	a.z-btn {
		text-decoration: none;
	}
</style>
