{
  "patcher": {
    "fileversion": 1,
    "appversion": {
      "major": 8,
      "minor": 6,
      "revision": 0
    },
    "rect": [50.0, 50.0, 900.0, 620.0],
    "bglocked": 0,
    "openinpresentation": 0,
    "default_fontsize": 12.0,
    "default_fontface": 0,
    "default_fontname": "Arial",
    "gridonopen": 0,
    "gridsize": [15.0, 15.0],
    "gridsnaponopen": 0,
    "boxes": [
      {"box": {"id": "notein", "maxclass": "newobj", "patching_rect": [40.0, 40.0, 80.0, 22.0], "text": "notein"}},
      {"box": {"id": "bendin", "maxclass": "newobj", "patching_rect": [160.0, 40.0, 80.0, 22.0], "text": "bendin"}},
      {"box": {"id": "ctlin", "maxclass": "newobj", "patching_rect": [260.0, 40.0, 80.0, 22.0], "text": "ctlin"}},

      {"box": {"id": "print_note", "maxclass": "newobj", "patching_rect": [40.0, 90.0, 90.0, 22.0], "text": "print NOTE"}},
      {"box": {"id": "print_bend", "maxclass": "newobj", "patching_rect": [160.0, 90.0, 90.0, 22.0], "text": "print PB"}},
      {"box": {"id": "print_cc", "maxclass": "newobj", "patching_rect": [260.0, 90.0, 90.0, 22.0], "text": "print CC"}},

      {"box": {"id": "unpack_note", "maxclass": "newobj", "patching_rect": [40.0, 130.0, 150.0, 22.0], "text": "unpack 0 0 0"}},
      {"box": {"id": "comment1", "maxclass": "comment", "patching_rect": [200.0, 130.0, 210.0, 22.0], "text": "note, velocity, channel"}},

      {"box": {"id": "strip", "maxclass": "newobj", "patching_rect": [40.0, 170.0, 70.0, 22.0], "text": "stripnote"}},
      {"box": {"id": "mtof", "maxclass": "newobj", "patching_rect": [40.0, 210.0, 50.0, 22.0], "text": "mtof"}},
      {"box": {"id": "sig_freq", "maxclass": "newobj", "patching_rect": [40.0, 250.0, 50.0, 22.0], "text": "sig~"}},

      {"box": {"id": "cc1_route", "maxclass": "newobj", "patching_rect": [260.0, 130.0, 150.0, 22.0], "text": "route 1"}},
      {"box": {"id": "cc_scale", "maxclass": "newobj", "patching_rect": [260.0, 170.0, 80.0, 22.0], "text": "/ 127."}},
      {"box": {"id": "lfo", "maxclass": "newobj", "patching_rect": [260.0, 210.0, 60.0, 22.0], "text": "cycle~ 5"}},
      {"box": {"id": "lfo_depth", "maxclass": "newobj", "patching_rect": [260.0, 250.0, 80.0, 22.0], "text": "*~ 5."}},
      {"box": {"id": "sum_freq", "maxclass": "newobj", "patching_rect": [140.0, 290.0, 50.0, 22.0], "text": "+~"}},

      {"box": {"id": "osc", "maxclass": "newobj", "patching_rect": [140.0, 330.0, 60.0, 22.0], "text": "cycle~"}},
      {"box": {"id": "adsr", "maxclass": "newobj", "patching_rect": [40.0, 330.0, 80.0, 22.0], "text": "adsr~ 5 50 0.6 200"}},
      {"box": {"id": "vel_scale", "maxclass": "newobj", "patching_rect": [100.0, 210.0, 60.0, 22.0], "text": "/ 127."}},
      {"box": {"id": "env_gain", "maxclass": "newobj", "patching_rect": [220.0, 370.0, 50.0, 22.0], "text": "*~"}},
      {"box": {"id": "gain", "maxclass": "gain~", "patching_rect": [300.0, 360.0, 120.0, 30.0]}},
      {"box": {"id": "ezdac", "maxclass": "ezdac~", "patching_rect": [450.0, 360.0, 45.0, 45.0]}},

      {"box": {"id": "vel_gate", "maxclass": "newobj", "patching_rect": [100.0, 250.0, 60.0, 22.0], "text": ">= 1"}},
      {"box": {"id": "gate_t", "maxclass": "newobj", "patching_rect": [100.0, 290.0, 70.0, 22.0], "text": "t i i"}},

      {"box": {"id": "comment2", "maxclass": "comment", "patching_rect": [40.0, 560.0, 760.0, 22.0], "text": "Note: Enable IAC in macOS MIDI Studio and select 'IAC Driver Bus 1' as input in Max > MIDI Setup. CC1 controls vibrato depth."}}
    ],
    "lines": [
      {"patchline": {"source": ["notein", 0], "destination": ["print_note", 0]}},
      {"patchline": {"source": ["bendin", 0], "destination": ["print_bend", 0]}},
      {"patchline": {"source": ["ctlin", 0], "destination": ["print_cc", 0]}},

      {"patchline": {"source": ["notein", 0], "destination": ["unpack_note", 0]}},
      {"patchline": {"source": ["notein", 1], "destination": ["unpack_note", 1]}},
      {"patchline": {"source": ["notein", 2], "destination": ["unpack_note", 2]}},

      {"patchline": {"source": ["unpack_note", 0], "destination": ["strip", 0]}},
      {"patchline": {"source": ["strip", 0], "destination": ["mtof", 0]}},
      {"patchline": {"source": ["mtof", 0], "destination": ["sig_freq", 0]}},
      {"patchline": {"source": ["sig_freq", 0], "destination": ["sum_freq", 0]}},
      {"patchline": {"source": ["sum_freq", 0], "destination": ["osc", 0]}},

      {"patchline": {"source": ["ctlin", 0], "destination": ["cc1_route", 0]}},
      {"patchline": {"source": ["cc1_route", 0], "destination": ["cc_scale", 0]}},
      {"patchline": {"source": ["cc_scale", 0], "destination": ["lfo", 1]}},
      {"patchline": {"source": ["lfo", 0], "destination": ["lfo_depth", 0]}},
      {"patchline": {"source": ["lfo_depth", 0], "destination": ["sum_freq", 1]}},

      {"patchline": {"source": ["unpack_note", 1], "destination": ["vel_scale", 0]}},
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
