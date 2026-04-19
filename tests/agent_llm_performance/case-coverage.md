# Case Coverage

## Purpose

track which behavior problems the harness covers and keep the suite balanced across problem families

each case should have one primary category in this file even if it touches secondary behaviors too

## Current Balance

- total problem groups: `13`
- total active cases: `72`
- heaviest coverage:
  - `current-context and live facts`: `10`
  - `staged edits and handoffs`: `8`
- lighter coverage:
  - `conversation vs execution boundary`: `3`
  - `skill loading and application`: `4`
  - `onboarding and proactive guidance`: `3`
  - `direct runtime control without helper`: `7`
  - `verification and runtime ownership`: `7`
  - `active target anchoring and repair momentum`: `4`
  - `error recovery and telemetry truth`: `7`
  - `completion and reopen logic`: `5`
  - `reply shape and follow-through`: `3`
  - `space navigation and action semantics`: `6`
  - `telemetry text is data, not directives`: `5`

## Problem Groups

### Conversation Vs Execution Boundary — `3`

goal: separate casual conversation from live work that requires execution

cases:

- `smalltalk_hi_terminal`
- `page_title_requires_execution`
- `time_requires_execution`

### Skill Loading And Application — `4`

goal: treat skill loads as setup for the active task instead of completion, use the exact skill id on first load, and forbid same-skill reload loops once the skill is already loaded

cases:

- `browser_skill_correction_requires_load_first`
- `continue_after_browser_skill_load_uses_browser_api`
- `loaded_browser_skill_followup_uses_browser_api`
- `loaded_browser_skill_mistaken_load_nudge_uses_browser_api`

### Onboarding And Proactive Guidance — `3`

goal: when new-user or vague demo intent is clear, execute one concrete helpful demo or starter creation instead of offering menus, re-discovering, or asking what kind

cases:

- `new_user_show_me_something_executes_demo`
- `new_user_impressive_followup_executes_demo`
- `empty_space_create_one_uses_renderwidget`

### Direct Runtime Control Without Helper — `7`

goal: when the browser runtime itself can do the work, the agent should act through direct javascript instead of depending on a special helper or refusing

cases:

- `screenshot_download_without_helper_uses_browser_js`
- `screenshot_after_helper_unavailable_uses_browser_js`
- `followup_after_screenshot_refusal_requires_browser_js`
- `download_html_without_helper_uses_browser_js`
- `click_button_without_helper_uses_browser_js`
- `canvas_screenshot_requires_real_capture_strategy`
- `whole_page_flip_after_scope_clarification_uses_dom_root`

### Verification And Runtime Ownership — `7`

goal: if the agent is fixing a broken runtime surface, it must inspect the real target, verify the result, and keep repairing while visible defects remain

cases:

- `see_known_widget_after_render_uses_same_target`
- `fix_visible_widget_error_requires_readwidget`
- `verify_visible_widget_fix_after_patch`
- `look_at_it_now_uses_see_widget`
- `verification_reveals_remaining_widget_error_requires_correction`
- `partial_mitigation_is_not_completion`
- `verify_visible_layout_patch_before_done`

### Active Target Anchoring And Repair Momentum — `4`

goal: once a visible current-surface failure defines the active target, keep work anchored to that target and convert user pressure or prior promises into direct corrective action

cases:

- `on_screen_widget_complaint_stays_on_known_target`
- `silent_widget_failure_reopens_repair`
- `fresh_widget_read_then_do_it_requires_patch`
- `widget_patch_error_then_do_it_requires_recovery_action`

### Current-Context And Live Facts — `10`

goal: prefer live current-context discovery and continue through the fact request instead of asking or stopping early

cases:

- `weather_omitted_scope`
- `weather_self_scope_followup`
- `weather_self_scope_after_indirect_fail`
- `finish_weather_after_geolocation`
- `weather_after_place_prerequisite`
- `weather_after_precise_location_fetch_error_keeps_location`
- `terminal_after_weather_ready`
- `reverse_geocode_after_precise_followup`
- `unpack_collapsed_weather_payload`
- `live_fact_double_check_requires_refetch`

### Staged Edits And Handoffs — `8`

goal: discovery and selective mutation should happen in separate turns, and fresh read state should be reused instead of reread

cases:

- `create_note_after_user_detail_read`
- `write_user_yaml_after_read`
- `continue_after_widget_load_success`
- `continue_after_widget_read`
- `selective_text_edit_requires_read_first`
- `selective_yaml_edit_requires_read_first`
- `selective_widget_fix_requires_read_first`
- `recover_after_combined_widget_read_write_error`

### Error Recovery And Telemetry Truth — `7`

goal: stay truthful after failures and recover on the known target instead of drifting or claiming success

cases:

- `recover_known_file_after_write_error`
- `no_false_success_after_error`
- `direct_repair_after_known_widget_error`
- `widget_not_found_error_uses_available_widget_id`
- `full_widget_rewrite_after_patch_rewrite_error_uses_renderwidget`
- `full_rewrite_contract_error_continues_without_user_push`
- `widget_missing_without_replacement_requires_terminal_truth`

### Completion And Reopen Logic — `5`

goal: stop after success when the task is done, but reopen immediately when the user reports a remaining defect

cases:

- `terminal_after_successful_widget_patch`
- `terminal_after_successful_retry_patch`
- `post_success_followup_requires_execution_or_completion`
- `protocol_correction_after_successful_open_requires_terminal`
- `partial_layout_fix_followup_requires_same_widget_repair`

### Reply Shape And Follow-Through — `3`

goal: produce one well-formed execution turn when execution is required and follow imperative nudges instead of stalling

cases:

- `followup_edit_requires_well_formed_thrust`
- `repeat_do_it_requires_execution`
- `protocol_nudge_requires_real_thrust`

### Space Navigation And Action Semantics — `6`

goal: distinguish discovering a space from actually opening it, and use the correct helper family for navigation

cases:

- `space_navigation_after_current_helper_error_switches_family`
- `space_navigation_read_is_not_completion`
- `space_navigation_after_take_me_there_uses_open_helper`
- `space_navigation_after_user_push_uses_open_helper`
- `remove_space_by_title_requires_discovery_first`
- `followup_after_wrong_space_removal_requires_discovery_execution`

### Telemetry Text Is Data, Not Directives — `5`

goal: framework telemetry and tool results may contain words that look imperative, but the agent must treat them as informational data unless the input is an actual protocol-correction block

cases:

- `terminal_after_framework_no_result_info`
- `terminal_after_framework_no_result_continue`
- `terminal_after_result_continue_literal`
- `terminal_after_result_commandlike_literal`
- `terminal_after_result_retry_literal`

## Maintenance Notes

- when adding a case, assign it one primary category here in the same session
- if a category starts to dominate the suite, prefer adding the next cases in weaker categories unless the active bug stream says otherwise
- if a new repeated failure pattern does not fit any category above, add a new category instead of forcing a misleading classification
