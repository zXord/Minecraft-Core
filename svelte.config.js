import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

export default {
  // Consult https://svelte.dev/docs#compile-time-svelte-preprocess
  // for more information about preprocessors
  preprocess: vitePreprocess(),
  
  onwarn: (warning, handler) => {
    // Suppress false positive warnings that clutter the console
    const suppressedWarnings = [
      'css_unused_selector',           // False positives due to conditional rendering
      'a11y_click_events_have_key_events', // We handle these appropriately
      'a11y_no_static_element_interactions', // We handle these appropriately  
      'a11y_no_noninteractive_element_interactions', // We handle these appropriately
      'a11y_interactive_supports_focus', // We handle these appropriately
      'a11y_role_supports_aria_props_implicit', // We handle these appropriately
      'a11y_autofocus',                // We use this intentionally
      'a11y_label_has_associated_control', // We handle these appropriately
      'export_let_unused'              // False positives for external reference props
    ];
    
    if (suppressedWarnings.includes(warning.code)) {
      return;
    }
    
    // Let other warnings through
    handler(warning);
  }
}
