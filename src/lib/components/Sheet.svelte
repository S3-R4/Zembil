<!--
  A bottom sheet — docs/DESIGN.md §5. Everything primary lives in the bottom
  third, so every modal in this app is a sheet rather than a centred dialog: a
  thumb reaches the bottom of a 390×844 phone and does not reach the middle.

  Uses <dialog> for the focus trap, Escape handling and inertness of the rest of
  the page, all of which the platform already implements correctly and none of
  which is worth reimplementing.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		onclose: () => void;
		children: Snippet;
	}

	let { open, title, onclose, children }: Props = $props();
	let dialog = $state<HTMLDialogElement | null>(null);

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	aria-label={title}
	onclose={onclose}
	onclick={(event) => {
		// The backdrop is the dialog element itself; a click that lands on the
		// panel bubbles from a child, so comparing targets is what tells them
		// apart without an extra overlay element.
		if (event.target === dialog) onclose();
	}}
>
	<div class="panel z-sheet-anim">
		<div class="grabber" aria-hidden="true"></div>
		<h2 class="z-card-title">{title}</h2>
		{@render children()}
	</div>
</dialog>

<style>
	dialog {
		width: 100%;
		max-width: 560px;
		margin: auto auto 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text);
	}

	dialog::backdrop {
		background: rgb(25 21 16 / 42%);
	}

	.panel {
		background: var(--surface);
		border-top-left-radius: 24px;
		border-top-right-radius: 24px;
		box-shadow: var(--shadow-sheet);
		padding: 14px 28px calc(28px + env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		gap: 16px;
		/* The sheet must never grow past the viewport on a short phone in
		 * landscape; its own content scrolls instead of the page behind it. */
		max-height: 88dvh;
		overflow-y: auto;
	}

	.grabber {
		width: 44px;
		height: 5px;
		border-radius: 3px;
		background: var(--border-strong);
		margin: 0 auto 6px;
	}
</style>
