"""Optional official Transformers parity check; not used by the application.

Run with the isolated reference environment and locally pinned official weights.
Inputs are identical NCHW f32 tensors saved by verify-layout-model-real.cjs.
"""
import argparse
import json
import sys
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--model',required=True)
parser.add_argument('--inputs',required=True)
parser.add_argument('--extra-site')
args=parser.parse_args()
if args.extra_site: sys.path.append(args.extra_site)
import numpy as np
import torch
from transformers import PPDocLayoutV3ForObjectDetection

torch.set_num_threads(4)
model=PPDocLayoutV3ForObjectDetection.from_pretrained(args.model,local_files_only=True).eval()
# The official image processor requires torchvision even for already-prepared
# tensors. Reproduce its tensor-only post-processing here; no image/mask path
# is needed for this comparison. Algorithm: sigmoid, global top-k, pointer votes.
def decode_official(output):
    scores=output.logits.sigmoid()[0]
    count,classes=scores.shape
    scores,indices=torch.topk(scores.flatten(),count)
    queries=indices//classes;labels=indices%classes
    keep=scores>=.5;queries=queries[keep];labels=labels[keep]
    matrix=output.order_logits.sigmoid()
    votes=torch.triu(matrix,diagonal=1).sum(dim=1)+torch.tril(1-matrix.transpose(1,2),diagonal=-1).sum(dim=1)
    pointers=torch.argsort(votes,dim=1,stable=True)
    ranks=torch.empty_like(pointers);ranks.scatter_(1,pointers,torch.arange(count).unsqueeze(0))
    ordered=torch.argsort(ranks[0,queries],stable=True)
    labels=labels[ordered];boxes=output.pred_boxes[0,queries[ordered]]
    centers,sizes=boxes[:,:2],boxes[:,2:]
    boxes=torch.cat([centers-.5*sizes,centers+.5*sizes],dim=1).clamp(0,1)
    return labels.tolist(),boxes.tolist(),queries[ordered].tolist()
results=[]
for filename in sorted(Path(args.inputs).glob('page-*.f32')):
    pixels=np.fromfile(filename,dtype=np.float32).reshape(1,3,800,800)
    with torch.inference_mode(): output=model(pixel_values=torch.from_numpy(pixels))
    actual=json.loads(filename.with_suffix('.json').read_text())['regions']
    labels,boxes,queries=decode_official(output)
    expected_keys=list(zip(queries,labels));actual_keys=[(r['query'],r['classId']) for r in actual]
    matching={key:r for key,r in zip(actual_keys,actual)}
    labels_match=sorted(expected_keys)==sorted(actual_keys)
    order_match=expected_keys==actual_keys
    ious=[]
    for key,expected in zip(expected_keys,boxes):
        if key not in matching: continue
        region=matching[key]
        got=region['bbox']
        intersection=max(0,min(expected[2],got[2])-max(expected[0],got[0]))*max(0,min(expected[3],got[3])-max(expected[1],got[1]))
        area=lambda b:max(0,b[2]-b[0])*max(0,b[3]-b[1])
        ious.append(intersection/(area(expected)+area(got)-intersection))
    row={'input':filename.name,'regions':len(actual),'labelsIdentical':labels_match,'readingOrderIdentical':order_match,'minimumBoxIoU':min(ious) if ious else None}
    results.append(row);print(json.dumps(row),flush=True)
Path(args.inputs,'official-parity.json').write_text(json.dumps(results,indent=2))
assert all(row['labelsIdentical'] and row['readingOrderIdentical'] and (row['minimumBoxIoU'] is None or row['minimumBoxIoU']>.9) for row in results),'Official parity failed; see official-parity.json'
