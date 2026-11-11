"""Five-beat, hard-cut feature demo from real component captures.
Keeps the earlier interaction recording unchanged as a fallback.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import subprocess, json, hashlib

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'harness/dist/hackathon/simple-final'
OUT.mkdir(parents=True,exist_ok=True)
SHOTS=ROOT/'assets/hackathon/screenshots'
DELIVERY=Path('C:/Users/jerry/projects/deliveries/provider-usage-0.10')
BG='#0d1117'; FG='#f0f3f6'; MUTED='#b8c0cc'; ACCENT='#6f98ff'
def font(n,bold=False):
    return ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf' if bold else 'C:/Windows/Fonts/segoeui.ttf',n)
def wrap(draw,text,f,width):
    out=[]; line=''
    for word in text.split():
        trial=(line+' '+word).strip()
        if draw.textlength(trial,font=f)>width and line:
            out.append(line); line=word
        else: line=trial
    if line: out.append(line)
    return out

def slide(index,title,body,shot=None,crop=None,note=None):
    im=Image.new('RGB',(1280,720),BG); d=ImageDraw.Draw(im)
    d.text((36,24),'Provider Usage',font=font(27,True),fill=FG)
    d.text((980,31),'Component demo',font=font(17),fill=MUTED)
    d.line((36,75,1244,75),fill='#30363d',width=1)
    d.text((36,116),f'0{index} / 05',font=font(18,True),fill=ACCENT)
    y=158
    for line in wrap(d,title,font(44,True),350):
        d.text((36,y),line,font=font(44,True),fill=FG); y+=55
    y+=22
    for line in wrap(d,body,font(25),344):
        d.text((36,y),line,font=font(25),fill=MUTED); y+=36
    if note:
        y=max(y+28,500)
        for line in wrap(d,note,font(18),344):
            d.text((36,y),line,font=font(18),fill=MUTED);y+=27
        assert y<680,('caption overflow',index,y)
    if shot:
        pic=Image.open(shot).convert('RGB')
        if crop: pic=pic.crop(crop)
        pic.thumbnail((820,566),Image.Resampling.LANCZOS)
        x=420+(820-pic.width)//2;y=106+(566-pic.height)//2
        im.paste(pic,(x,y));d.rounded_rectangle((x-1,y-1,x+pic.width,y+pic.height),radius=6,outline='#30363d',width=1)
    for i in range(5):
        d.rounded_rectangle((36+i*39,689,64+i*39,693),radius=2,fill=ACCENT if i==index-1 else '#30363d')
    p=OUT/f'slide-{index}.png';im.save(p);return p

slides=[]
slides.append(slide(1,'Limits, at a glance.','Click the usage chip in the bottom status bar. See remaining usage, reset times and paid fallback.',SHOTS/'02-popover-current.png',(0,0,808,812),'* Plus-plan example. Pro plans currently have no five-hour limit.'))
slides.append(slide(2,'Your providers. Your credits.','OpenRouter and DeepSeek, each with its own balance. Open the full page from View all providers or the left sidebar.',SHOTS/'04-overview-multi-provider.png',(35,1250,1485,1820)))
slides.append(slide(3,'Add the services you use.','Read-only JSON connectors bring more usage APIs into the same view, with clear setup and approval states.',SHOTS/'07-catalog-available.png'))
slides.append(slide(4,'Review a reset before you use it.','Check Codex banked resets, review the account and counts, then explicitly confirm. This demo stops at preview.',SHOTS/'12-reset-confirm.png',(35,275,1485,805)))
end=Image.new('RGB',(1280,720),BG);d=ImageDraw.Draw(end)
d.text((50,42),'Provider Usage · Hermes Desktop',font=font(27,True),fill=MUTED)
d.text((50,140),'Know your limits.',font=font(65,True),fill=FG)
d.text((50,227),'Keep your work moving.',font=font(65,True),fill=FG)
d.text((50,340),'Subscription windows. API credits. One place.',font=font(31),fill=MUTED)
d.rounded_rectangle((50,423,1230,504),radius=10,fill='#161b22',outline='#30363d')
d.text((74,446),'hermes plugins install jerrygooch/hermes-provider-usage',font=font(30,True),fill=FG)
d.text((50,550),'Bottom status bar → usage panel',font=font(26),fill=MUTED)
d.text((50,594),'Left sidebar → Provider Usage',font=font(26),fill=MUTED)
d.text((50,660),'* Usage figures are sample data, not real account usage.  ·  Component demo',font=font(20),fill=MUTED)
endpath=OUT/'slide-5.png';end.save(endpath);slides.append(endpath)
# Contact sheet is a pre-encode visual gate.
contact=Image.new('RGB',(1280,1080),BG)
for i,p in enumerate(slides):
    tile=Image.open(p).resize((640,360));contact.paste(tile,((i%2)*640,(i//2)*360))
contact.save(OUT/'contact.png')
if '--frames-only' in __import__('sys').argv:
    print(OUT/'contact.png');raise SystemExit

segments=[]
durations=[18,20,16,18,14]
for i,(p,duration) in enumerate(zip(slides,durations),1):
    target=OUT/f'segment-{i}.mp4'
    # The credit scene includes the real captured DeepSeek expansion/hover.
    if i==2:
        args=['ffmpeg','-v','error','-y','-loop','1','-i',str(p),'-ss','37','-t','5','-i',str(DELIVERY/'demo-x-v4.mp4'),'-filter_complex','[1:v]crop=840:330:395:350,scale=820:322,tpad=stop_mode=clone:stop_duration=15[v];[0:v][v]overlay=420:228:shortest=1[out]','-map','[out]']
    else:
        args=['ffmpeg','-v','error','-y','-loop','1','-i',str(p)]
    args+=['-t',str(duration),'-r','30','-c:v','libx264','-preset','veryfast','-profile:v','main','-level','3.1','-crf','18','-pix_fmt','yuv420p',str(target)]
    subprocess.run(args,check=True);segments.append(target)
concat=OUT/'concat.txt';concat.write_text(''.join("file '"+str(p).replace('\\','/')+"'\n" for p in segments))
final=DELIVERY/'demo-x-final-simple.mp4'
subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(concat),'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-c:v','copy','-c:a','aac','-shortest','-movflags','+faststart',str(final)],check=True)
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration,size','-of','json',str(final)]))
assert float(probe['format']['duration'])<90
receipt={'file':str(final),'sha256':hashlib.sha256(final.read_bytes()).hexdigest(),'probe':probe,'holds':durations,'transitions':'hard cuts; one headline per scene','sources':[str(p) for p in slides],'real_interaction':'credit scene cropped from verified component recording, seconds 37–42; held final frame','codex_plan_note_scenes':[1]}
(OUT/'receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt,indent=2))
