<!--
  The error page. Shows what the server said (§3.1 writes `message` for a
  person), not a substitute of our own — a member who followed a link to a store
  that was archived should read "Store not found", not "Internal Error".
-->
<script lang="ts">
	import { page } from '$app/state';

	let code = $derived(page.error?.code ?? '');
	let offline = $derived(code === 'OFFLINE');
	let title = $derived(
		offline
			? 'No signal'
			: page.status === 404
				? 'Not here'
				: page.status === 403
					? 'Not for you'
					: page.status === 401
						? 'Please sign in'
						: 'Something went wrong'
	);
</script>

<svelte:head><title>{title} · Zembil</title></svelte:head>

<main>
	<div>
		<h1 class="z-display">{title}</h1>
		<p class="z-meta">{page.error?.message ?? 'Please try again.'}</p>
	</div>
	<div class="actions">
		{#if offline || page.status >= 500}
			<button class="z-btn" type="button" onclick={() => location.reload()}>Retry</button>
		{/if}
		{#if page.status === 401}
			<a class="z-btn" href="/login">Sign in</a>
		{:else}
			<a class="z-btn z-btn--secondary" href="/">Back to shops</a>
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
