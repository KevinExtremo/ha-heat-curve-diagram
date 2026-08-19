# Heat Curve Card

A Home Assistant Lovelace card for editing hourly `input_number` schedules by dragging points
directly on a chart, instead of hunting through a slider list.

- Any number of lines on one chart, each backed by a series of `input_number` entities (one per
  hour).
- Drag any point up or down to change that hour's value — updates live via `input_number.set_value`.
- Two lines can be declared as a min/max pair with a required minimum gap (e.g. 0.5°C) that's
  enforced live while dragging, so they can never cross or touch.

## Install

Via HACS: **HACS → ⋮ → Custom repositories** → add this repository URL, category **Frontend** →
**Install** → restart Home Assistant if prompted.

## Example config

```yaml
type: custom:heat-curve-card
title: Hobby Room — Heat Curve
hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
y_range: [16, 26]
step: 0.5
lines:
  - id: heat_min
    entity_prefix: input_number.hobby_room_heat_min_
    color: "#2980b9"
    label: Heat Min
    role: min
    pair: heat_max
    min_gap: 0.5
  - id: heat_max
    entity_prefix: input_number.hobby_room_heat_max_
    color: "#e74c3c"
    label: Heat Max
    role: max
    pair: heat_min
    min_gap: 0.5
  - id: cool_min
    entity_prefix: input_number.hobby_room_cool_min_
    color: "#1abc9c"
    label: Cool Min
    role: min
    pair: cool_max
    min_gap: 0.5
  - id: cool_max
    entity_prefix: input_number.hobby_room_cool_max_
    color: "#f39c12"
    label: Cool Max
    role: max
    pair: cool_min
    min_gap: 0.5
```

Each line maps to entities named `<entity_prefix><HH>` for every hour in `hours` (e.g.
`input_number.hobby_room_heat_min_08`). `pair`/`role`/`min_gap` are optional — omit them for an
unpaired, freely-draggable line.
