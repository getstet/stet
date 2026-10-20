<template>
  <nav :aria-label="copy.nav_label">{{ copy.cta_label }}</nav>
</template>
<script setup lang="ts">
import { copy } from '@/lib/content';
</script>
