<!--
  Admin — docs/DESIGN.md §4, CONTRACT.md §3.3.

  Every temporary password this screen shows is shown ONCE: the server generates
  it, returns it in that one response, and stores only its hash. So the sheet
  that displays it does not close on a stray tap, and it says so.
-->
<script lang="ts">
	import { api } from '$lib/client/api';
	import { messageOf } from '$lib/client/app.svelte';
	import { shortDate } from '$lib/client/time';
	import type { AdminUser } from '$lib/types';
	import Banner from '$lib/components/Banner.svelte';
	import Sheet from '$lib/components/Sheet.svelte';

	let { data } = $props();

	let fetched = $state<AdminUser[] | null>(null);
	let users = $derived(fetched ?? data.users);
	let error = $state<string | null>(null);
	let busy = $state<string | null>(null);

	async function refresh() {
		const body = await api<{ users: AdminUser[] }>('/api/admin/users');
		fetched = body.users;
	}

	async function run(key: string, fn: () => Promise<void>) {
		if (busy) return;
		busy = key;
		error = null;
		try {
			await fn();
			await refresh();
		} catch (err) {
			error = messageOf(err);
		} finally {
			busy = null;
		}
	}

	function status(user: AdminUser): string {
		if (!user.isActive) return `Disabled ${shortDate(user.disabledAt)}`;
		if (user.passkeyCount === 0) return 'Active · password only';
		return `Active · ${user.passkeyCount} ${user.passkeyCount === 1 ? 'passkey' : 'passkeys'}`;
	}

	// ---- new user ---------------------------------------------------------
	let creating = $state(false);
	let newUsername = $state('');
	let newDisplayName = $state('');
	let newIsAdmin = $state(false);

	// ---- the one-time password reveal -------------------------------------
	let reveal = $state<{ who: string; password: string } | null>(null);

	async function createUser(event: SubmitEvent) {
		event.preventDefault();
		const username = newUsername.trim();
		const displayName = newDisplayName.trim() || username;
		if (busy || username.length === 0) return;
		await run('create', async () => {
			const body = await api<{ user: AdminUser; temporaryPassword: string }>('/api/admin/users', {
				method: 'POST',
				body: { username, displayName, isAdmin: newIsAdmin }
			});
			creating = false;
			newUsername = '';
			newDisplayName = '';
			newIsAdmin = false;
			reveal = { who: body.user.displayName, password: body.temporaryPassword };
		});
	}

	const resetPassword = (user: AdminUser) =>
		run(`reset:${user.id}`, async () => {
			const body = await api<{ temporaryPassword: string }>(
				`/api/admin/users/${user.id}/reset-password`,
				{ method: 'POST', body: {} }
			);
			reveal = { who: user.displayName, password: body.temporaryPassword };
		});

	const setActive = (user: AdminUser, isActive: boolean) =>
		run(`active:${user.id}`, async () => {
			await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { isActive } });
		});

	const setAdmin = (user: AdminUser, isAdmin: boolean) =>
		run(`admin:${user.id}`, async () => {
			await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: { isAdmin } });
		});

	const clearPasskeys = (user: AdminUser) =>
		run(`passkeys:${user.id}`, async () => {
			await api(`/api/admin/users/${user.id}/passkeys`, { method: 'DELETE' });
		});
</script>

<svelte:head><title>Family · Zembil</title></svelte:head>

<header>
	<a class="back" href="/you" aria-label="Back to your account">
		<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
			<path
				d="M15 5 8 12l7 7"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</a>
	<div>
		<p class="z-eyebrow">Accounts</p>
		<h1 class="z-title">The family</h1>
	</div>
</header>

<div class="body">
	<Banner message={error} />

	<ul>
		{#each users as user (user.id)}
			<li class="z-card" class:off={!user.isActive}>
				<div class="row">
					<div class="grow">
						<p class="name">{user.displayName}</p>
						<p class="z-meta">{user.username} · {status(user)}</p>
					</div>
					{#if user.isAdmin}<span class="z-chip admin">Admin</span>{/if}
				</div>

				<div class="actions">
					<button
						class="z-btn z-btn--tertiary z-btn--auto"
						type="button"
						disabled={busy !== null}
						onclick={() => resetPassword(user)}
					>
						Reset password
					</button>
					{#if user.passkeyCount > 0}
						<button
							class="z-btn z-btn--tertiary z-btn--auto"
							type="button"
							disabled={busy !== null}
							onclick={() => clearPasskeys(user)}
						>
							Remove passkeys
						</button>
					{/if}
					<button
						class="z-btn z-btn--tertiary z-btn--auto"
						type="button"
						disabled={busy !== null}
						onclick={() => setAdmin(user, !user.isAdmin)}
					>
						{user.isAdmin ? 'Remove admin' : 'Make admin'}
					</button>
					{#if user.isActive}
						<button
							class="z-btn z-btn--tertiary z-btn--danger z-btn--auto"
							type="button"
							disabled={busy !== null}
							onclick={() => setActive(user, false)}
						>
							Disable
						</button>
					{:else}
						<button
							class="z-btn z-btn--tertiary z-btn--auto"
							type="button"
							disabled={busy !== null}
							onclick={() => setActive(user, true)}
						>
							Enable
						</button>
					{/if}
				</div>
			</li>
		{/each}
	</ul>

	<button class="z-btn" type="button" onclick={() => (creating = true)}>New person</button>
</div>

<Sheet open={creating} title="New person" onclose={() => (creating = false)}>
	<Banner message={error} />
	<form onsubmit={createUser}>
		<label class="sr-only" for="new-username">Username</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="z-field"
			id="new-username"
			placeholder="Username"
			maxlength="32"
			autocapitalize="none"
			autocorrect="off"
			spellcheck="false"
			autofocus
			bind:value={newUsername}
		/>
		<label class="sr-only" for="new-display">Name shown in the app</label>
		<input
			class="z-field"
			id="new-display"
			placeholder="Name shown in the app"
			maxlength="60"
			bind:value={newDisplayName}
		/>
		<label class="check">
			<input type="checkbox" bind:checked={newIsAdmin} />
			<span>Can manage accounts</span>
		</label>
		<button class="z-btn" type="submit" disabled={busy !== null || newUsername.trim().length === 0}>
			{busy === 'create' ? 'Creating…' : 'Create account'}
		</button>
	</form>
</Sheet>

<Sheet open={reveal !== null} title="Give them this password" onclose={() => (reveal = null)}>
	{#if reveal}
		<p class="z-meta">
			This is the only time it will ever be shown — it is not stored anywhere. {reveal.who} will have
			to choose their own password the first time they sign in.
		</p>
		<p class="password">{reveal.password}</p>
		<button class="z-btn" type="button" onclick={() => (reveal = null)}>I have written it down</button>
	{/if}
</Sheet>

<style>
	header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 20px 24px 12px;
	}

	.back {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		margin-left: -10px;
		border-radius: 14px;
		color: var(--accent);
	}

	.body {
		padding: 0 20px 32px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	li {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	li.off {
		opacity: 0.72;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.grow {
		flex: 1;
		min-width: 0;
	}

	.name {
		font-size: 21px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.admin {
		font-size: 12px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		font-size: 17px;
	}

	.check input {
		width: 24px;
		height: 24px;
		accent-color: var(--accent);
	}

	.password {
		font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, monospace;
		font-size: 24px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-align: center;
		padding: 20px 12px;
		border-radius: 18px;
		background: var(--surface-muted);
		user-select: all;
		overflow-wrap: anywhere;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
</style>
