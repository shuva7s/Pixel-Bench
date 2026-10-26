"""Converts the official Real-ESRGAN realesr-general-x4v3 weights (BSD-3-Clause,
https://github.com/xinntao/Real-ESRGAN) to ONNX and checks parity.

SRVGGNetCompact is re-declared here from the Real-ESRGAN source
(realesrgan/archs/srvgg_arch.py, BSD-3-Clause) so the export does not depend
on the basicsr package."""
import os
import time

import numpy as np
import onnxruntime as ort
import torch
from torch import nn
from torch.nn import functional as F

MODELS = os.path.expanduser("~/models")


class SRVGGNetCompact(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        base = F.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


net = SRVGGNetCompact()
state = torch.load(f"{MODELS}/realesr-general-x4v3.pth", map_location="cpu", weights_only=True)
net.load_state_dict(state["params"] if "params" in state else state["params_ema"], strict=True)
net.eval()

dummy = torch.rand(1, 3, 64, 48)
out_path = f"{MODELS}/realesr-general-x4v3.onnx"
torch.onnx.export(
    net,
    dummy,
    out_path,
    input_names=["input"],
    output_names=["output"],
    dynamic_axes={"input": {2: "h", 3: "w"}, "output": {2: "h4", 3: "w4"}},
    opset_version=17,
    dynamo=False,
)
print("exported", out_path, os.path.getsize(out_path), "bytes")

# Parity: torch vs onnxruntime on a random tile and a photo-like gradient.
sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
for name, x in [("random", torch.rand(1, 3, 37, 53)), ("gradient", torch.linspace(0, 1, 3 * 64 * 64).reshape(1, 3, 64, 64))]:
    with torch.no_grad():
        ref = net(x).numpy()
    t = time.time()
    got = sess.run(None, {"input": x.numpy()})[0]
    print(f"{name}: shape {got.shape}, max |diff| {np.abs(ref - got).max():.2e}, {time.time() - t:.2f}s")

# Speed on a 256x256 tile (a typical browser tile).
x = np.random.rand(1, 3, 256, 256).astype(np.float32)
t = time.time()
sess.run(None, {"input": x})
print(f"256x256 tile -> 1024x1024: {time.time() - t:.2f}s (native CPU)")
