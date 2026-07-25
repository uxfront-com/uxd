<script setup lang="ts">
defineOptions({
	inheritAttrs: false,
});
</script>

<template>
	<MorphingGradientBackground v-slot="{ onMousemove }">
		<UPageHero v-bind="$attrs" @mousemove="onMousemove">
			<slot />
			<template #title><slot name="title" /></template>
			<template #description><slot name="description" /></template>
			<template #headline><slot name="headline" /></template>
			<template #links><slot name="links" /></template>
		</UPageHero>
	</MorphingGradientBackground>
</template>

<style scoped>
/*
 * WCAG 1.4.3 Contrast (Minimum).
 *
 * At the layer's default --intensity: 0.2 the gradient swings the hero
 * background far enough that body text fails in both colour modes — measured
 * 2.42:1 (light) and 2.95:1 (dark) against the description. Dialling it down
 * keeps the gradient legible as decoration while pulling every foreground back
 * over its bar. The description token is raised from `text-muted` to
 * `text-toned` in content/index.md for the same reason: `text-muted` is only
 * 4.76:1 on a flat white background, so no amount of intensity reduction
 * leaves it any headroom.
 *
 * 0.08 rather than 0.1 because the `[one command]{.text-primary}` span in the
 * h1 is the tightest foreground on the page: at 0.1 it measured 3.16:1 against
 * the darkest pixel the gradient reaches, which clears the 3:1 large-text bar
 * by 5% and would regress on any future palette tweak.
 *
 * Selector is doubled to out-specify the child's own scoped rule, which sets
 * --intensity at the same (0,2,0) specificity this file would otherwise emit.
 */
.morphing-gradient-background.morphing-gradient-background {
	--intensity: 0.08;
}

/*
 * WCAG 2.3.3 Animation from Interactions.
 *
 * MorphingGradientBackground runs five infinite gradient animations plus a
 * bubble that follows the pointer. Freeze all of it when the visitor has asked
 * for reduced motion: the gradient still renders, it just stops moving.
 *
 * `!important` is required because the source rules live in the child's own
 * scoped stylesheet at a higher specificity than `:deep()` can emit from here.
 * The permanent fix is a guard inside @uxfront/layer-docs, which would also
 * stop the requestAnimationFrame loop this override can only render inert.
 */
@media (prefers-reduced-motion: reduce) {
	:deep(.gradients-container > *) {
		animation: none !important;
	}

	:deep(.gradients-container .interactive) {
		display: none;
	}
}
</style>
