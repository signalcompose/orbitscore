{
  "patcher": {
    "fileversion": 1,
    "appversion": {"major": 8, "minor": 6, "revision": 0},
    "rect": [50.0, 50.0, 1000.0, 700.0],
    "bglocked": 0,
    "openinpresentation": 0,
    "default_fontsize": 12.0,
    "default_fontface": 0,
    "default_fontname": "Arial",
    "gridonopen": 0,
    "boxes": [
      {"box": {"id": "notein", "maxclass": "newobj", "patching_rect": [40.0, 40.0, 80.0, 22.0], "text": "notein"}},
      {"box": {"id": "ctlin", "maxclass": "newobj", "patching_rect": [140.0, 40.0, 80.0, 22.0], "text": "ctlin"}},
      {"box": {"id": "bendin", "maxclass": "newobj", "patching_rect": [240.0, 40.0, 80.0, 22.0], "text": "bendin"}},

      {"box": {"id": "pack_note", "maxclass": "newobj", "patching_rect": [40.0, 80.0, 100.0, 22.0], "text": "pack i i i"}},
      {"box": {"id": "fmt_note", "maxclass": "newobj", "patching_rect": [160.0, 80.0, 500.0, 22.0], "text": "sprintf symout \"{\\\"type\\\":\\\"note\\\",\\\"ch\\\":%ld,\\\"note\\\":%ld,\\\"vel\\\":%ld}\""}},

      {"box": {"id": "pack_cc", "maxclass": "newobj", "patching_rect": [40.0, 120.0, 100.0, 22.0], "text": "pack i i i"}},
      {"box": {"id": "fmt_cc", "maxclass": "newobj", "patching_rect": [160.0, 120.0, 500.0, 22.0], "text": "sprintf symout \"{\\\"type\\\":\\\"cc\\\",\\\"ch\\\":%ld,\\\"cc\\\":%ld,\\\"val\\\":%ld}\""}},

      {"box": {"id": "pack_pb", "maxclass": "newobj", "patching_rect": [40.0, 160.0, 80.0, 22.0], "text": "pack i i"}},
      {"box": {"id": "fmt_pb", "maxclass": "newobj", "patching_rect": [140.0, 160.0, 440.0, 22.0], "text": "sprintf symout \"{\\\"type\\\":\\\"pb\\\",\\\"ch\\\":%ld,\\\"val\\\":%ld}\""}},

      {"box": {"id": "udpsend", "maxclass": "newobj", "patching_rect": [760.0, 100.0, 140.0, 22.0], "text": "udpsend 127.0.0.1 7474"}},
      {"box": {"id": "print", "maxclass": "newobj", "patching_rect": [620.0, 140.0, 100.0, 22.0], "text": "print TELE"}},
      {"box": {"id": "preaddr", "maxclass": "newobj", "patching_rect": [620.0, 100.0, 90.0, 22.0], "text": "prepend /tele"}},

      {"box": {"id": "comment", "maxclass": "comment", "patching_rect": [40.0, 200.0, 700.0, 22.0], "text": "Telemetry: send JSON via sprintf -> udpsend (run npm run telemetry:max)"}},

      {"box": {"id": "strip", "maxclass": "newobj", "patching_rect": [40.0, 250.0, 70.0, 22.0], "text": "stripnote"}},
      {"box": {"id": "mtof", "maxclass": "newobj", "patching_rect": [120.0, 250.0, 50.0, 22.0], "text": "mtof"}},
      {"box": {"id": "sig_freq", "maxclass": "newobj", "patching_rect": [180.0, 250.0, 50.0, 22.0], "text": "sig~"}},
      {"box": {"id": "lfo", "maxclass": "newobj", "patching_rect": [260.0, 250.0, 60.0, 22.0], "text": "cycle~ 5"}},
      {"box": {"id": "lfo_depth", "maxclass": "newobj", "patching_rect": [330.0, 250.0, 80.0, 22.0], "text": "*~ 5."}},
      {"box": {"id": "sum_freq", "maxclass": "newobj", "patching_rect": [420.0, 250.0, 50.0, 22.0], "text": "+~"}},
      {"box": {"id": "osc", "maxclass": "newobj", "patching_rect": [480.0, 290.0, 60.0, 22.0], "text": "cycle~"}},
      {"box": {"id": "adsr", "maxclass": "newobj", "patching_rect": [40.0, 290.0, 80.0, 22.0], "text": "adsr~ 5 50 0.6 200"}},
      {"box": {"id": "vel_scale", "maxclass": "newobj", "patching_rect": [120.0, 290.0, 60.0, 22.0], "text": "/ 127."}},
      {"box": {"id": "vel_gate", "maxclass": "newobj", "patching_rect": [200.0, 290.0, 60.0, 22.0], "text": ">= 1"}},
      {"box": {"id": "gate_t", "maxclass": "newobj", "patching_rect": [270.0, 290.0, 70.0, 22.0], "text": "t i i"}},
      {"box": {"id": "env_gain", "maxclass": "newobj", "patching_rect": [560.0, 330.0, 50.0, 22.0], "text": "*~"}},
      {"box": {"id": "gain", "maxclass": "gain~", "patching_rect": [630.0, 320.0, 120.0, 30.0]}},
      {"box": {"id": "ezdac", "maxclass": "ezdac~", "patching_rect": [780.0, 320.0, 45.0, 45.0]}}
    ],
    "lines": [
      {"patchline": {"source": ["notein", 0], "destination": ["pack_note", 1]}},
      {"patchline": {"source": ["notein", 1], "destination": ["pack_note", 2]}},
      {"patchline": {"source": ["notein", 2], "destination": ["pack_note", 0]}},
      {"patchline": {"source": ["pack_note", 0], "destination": ["fmt_note", 0]}},

      {"patchline": {"source": ["ctlin", 2], "destination": ["pack_cc", 0]}},
      {"patchline": {"source": ["ctlin", 1], "destination": ["pack_cc", 1]}},
      {"patchline": {"source": ["ctlin", 0], "destination": ["pack_cc", 2]}},
      {"patchline": {"source": ["pack_cc", 0], "destination": ["fmt_cc", 0]}},

      {"patchline": {"source": ["bendin", 1], "destination": ["pack_pb", 0]}},
      {"patchline": {"source": ["bendin", 0], "destination": ["pack_pb", 1]}},
      {"patchline": {"source": ["pack_pb", 0], "destination": ["fmt_pb", 0]}},

      {"patchline": {"source": ["fmt_note", 0], "destination": ["preaddr", 0]}},
      {"patchline": {"source": ["fmt_cc", 0], "destination": ["preaddr", 0]}},
      {"patchline": {"source": ["fmt_pb", 0], "destination": ["preaddr", 0]}},
      {"patchline": {"source": ["preaddr", 0], "destination": ["udpsend", 0]}},
      {"patchline": {"source": ["fmt_note", 0], "destination": ["print", 0]}},

      {"patchline": {"source": ["notein", 0], "destination": ["strip", 0]}},
      {"patchline": {"source": ["strip", 0], "destination": ["mtof", 0]}},
      {"patchline": {"source": ["mtof", 0], "destination": ["sig_freq", 0]}},
      {"patchline": {"source": ["sig_freq", 0], "destination": ["sum_freq", 0]}},
      {"patchline": {"source": ["lfo", 0], "destination": ["lfo_depth", 0]}},
      {"patchline": {"source": ["lfo_depth", 0], "destination": ["sum_freq", 1]}},
      {"patchline": {"source": ["sum_freq", 0], "destination": ["osc", 0]}},

      {"patchline": {"source": ["notein", 1], "destination": ["vel_scale", 0]}},
      {"patchline": {"source": ["vel_scale", 0], "destination": ["vel_gate", 0]}},
      {"patchline": {"source": ["vel_gate", 0], "destination": ["gate_t", 0]}},
      {"patchline": {"source": ["gate_t", 0], "destination": ["adsr", 0]}},

      {"patchline": {"source": ["osc", 0], "destination": ["env_gain", 0]}},
      {"patchline": {"source": ["adsr", 0], "destination": ["env_gain", 1]}},
      {"patchline": {"source": ["env_gain", 0], "destination": ["gain", 0]}},
      {"patchline": {"source": ["gain", 0], "destination": ["ezdac", 0]}},
      {"patchline": {"source": ["gain", 0], "destination": ["ezdac", 1]}}
    ]
  }
}
