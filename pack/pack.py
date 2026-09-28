# -*- coding: utf-8 -*-
"""Pack an unpacked docx template tree into a .docx, substituting word/document.xml.
usage: pack.py <tpl_dir> <document.xml> <out.docx>"""
import os, shutil, sys, zipfile

def pack(tpl, doc_xml, out_path):
    tmp = out_path + '.stage'
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    shutil.copytree(tpl, tmp)
    shutil.copyfile(doc_xml, os.path.join(tmp, 'word', 'document.xml'))
    if os.path.exists(out_path):
        os.remove(out_path)
    zf = zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED)
    zf.write(os.path.join(tmp, '[Content_Types].xml'), '[Content_Types].xml')
    for root, dirs, files in os.walk(tmp):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, tmp).replace(os.sep, '/')
            if rel == '[Content_Types].xml':
                continue
            zf.write(full, rel)
    zf.close()
    shutil.rmtree(tmp)
    print('packed:', out_path, os.path.getsize(out_path), 'bytes')

if __name__ == '__main__':
    pack(sys.argv[1], sys.argv[2], sys.argv[3])
