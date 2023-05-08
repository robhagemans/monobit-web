"use strict";

// monobit web app - hoard of bitfonts
// (c) 2023 Rob Hagemans
// licence: https://opensource.org/licenses/MIT

let pyodide = null;

// mount a persistent filesystem
const mountDir = "/repo";
const tempDir = "/temp";

function setup() {
    pyodide = setupPyodide();
    setupFonts();
}


///////////////////////////////////////////////////////////////////////////////
// pyodide

async function setupPyodide() {
    let pyodide = await loadPyodide();
    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");
    await Promise.all([
        micropip.install("monobit", /*keep_going*/ true, /*deps*/ false),
        micropip.install("pillow"),
        micropip.install("fonttools"),
    ]);
    // do not await optional format dependencies
    micropip.install("lzma")

    pyodide.FS.mkdir(tempDir);
    pyodide.FS.mkdir(mountDir);
    // pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, { root: "." }, mountDir);
    // pyodide.FS.syncfs(true, function(err){});

    console.log('Pyodide setup complete.')
    return pyodide;
}

///////////////////////////////////////////////////////////////////////////
// font sample

function baseName(filename) {
    return filename.split("/").pop();
}

async function loadFont(fontobj, element, placeholder) {
    // render a sample to image
    let render = await showFont(fontobj);
    // replace link with name and image
    element.innerHTML = render.name + '&emsp;<i>' + render.path + '</i>';
    let image = document.createElement('img');
    image.src = render.imageUrl;
    placeholder.replaceWith(image);
    // buttons after text
    element.before(setupButton('PNG', 'png', 'image', fontobj));
    element.before(setupButton('OTB', 'otb', 'sfnt', fontobj));
    element.before(setupButton('BDF', 'bdf', 'bdf', fontobj));
    element.before(setupButton('FON', 'fon', 'mzfon', fontobj));
    element.before(setupButton('BMFONT', 'fnt.zip', 'bmfont.zip', fontobj));
    element.before(setupButton('YAFF', 'yaff', 'yaff', fontobj));
}

function setupButton(label, suffix, format, fontobj) {
    //
    // conversion/download buttons
    //
    let button = document.createElement('button');
    button.innerHTML = '&#9662; ' + label;
    button.onclick = () => { download(suffix, format, fontobj) };
    return button;
}

async function ensureFile(fontobj, localPath) {
    let py = await pyodide;
    if (!py.FS.analyzePath(localPath).exists) {
        console.log('retrieving ' + localPath)
        // get the font source from the repo
        const yaffblob = await blobFromGithub(fontobj);
        const yaff = await yaffblob.text();
        py.FS.writeFile(localPath, yaff);
    }
}

async function showFont(fontobj) {
    const sample = "A quick brown fox jumps over the lazy dog."

    const path = baseName(fontobj.path);
    if (!path) return;
    const localPath = mountDir + '/' + path

    let record = JSON.parse(localStorage.getItem(fontobj.path));
    let fileData = null;
    let name = null;

    if (record == null || record.fileData == null) {
        let py = await pyodide;
        await ensureFile(fontobj, localPath);
        py.globals.set("font_path", localPath);
        py.globals.set("temp_path", tempDir + "/" + path);
        py.globals.set("sample", sample);
        await py.runPython(`if 1:
            import monobit
            from PIL import Image

            font, *_ = monobit.load(font_path)
            name = font.name

            print(f'rendering {font_path}')
            try:
                font.get_glyph('A')
                font.get_glyph('a')
            except KeyError:
                sample = sample.encode('latin-1')
            image = monobit.render(font, sample, direction='ltr f').as_image()
            image = image.resize((image.width*2, image.height*2), resample=Image.NEAREST)

            image_path = temp_path + '.png'
            image.save(image_path)
        `);
        name = py.globals.get("name");
        const imagePath = py.globals.get("image_path");
        fileData = py.FS.readFile(imagePath);

        let binary = '';
        // var bytes = new Uint8Array(fileData);
        var len = fileData.byteLength;
        for (var i = 0; i < len; i++) {
            binary += String.fromCharCode(fileData[i]);
        }

        record = {'name': name, 'fileData': btoa(binary)};
        localStorage.setItem(fontobj.path, JSON.stringify(record))
    }
    else {
        name = record.name;
        let rfd = atob(record.fileData);
        fileData = new Uint8Array(rfd.length);
        for (let i = 0; i < rfd.length; i++) {
            fileData[i] = rfd.charCodeAt(i);
        }
        // fileData = new Uint8Array(atob(record.fileData));
    }
    const blob = new Blob([fileData], {type : 'image/x-png'});
    const imageUrl = window.URL.createObjectURL(blob);
    return {name, imageUrl, path};
}


///////////////////////////////////////////////////////////////////////////////
// font collection

async function setupFonts() {
    //
    // retrieve font list from Github and show
    //
    let tree = await fontListFromGithub();
    let links = await buildCollection(tree);

    // reveal fonts
    for(let link of links) {
        try
        {
            await loadFont(link.member, link.element, link.a);
        }
        catch(err) {
            console.log('Error rendering ' + link.member.path);
            console.log(err.message);
        }
    }
    let py = await pyodide;
    py.FS.syncfs(false, function(err){});
}


async function buildCollection(collection) {
    //
    // show list of available fonts
    //
    let links = [];
    let parent = document.getElementById("font-list");
    let staging = null;
    for(let member of collection) {
        if (member.type == "tree") {
            let h2 = document.createElement("h2");
            h2.innerHTML = member.path;
            staging = h2
        }
        else if (member.path.endsWith('.yaff') || member.path.endsWith('.draw')) {
            if (staging != null) {
                parent.appendChild(staging);
                staging = null;
            }
            let p = parent.appendChild(document.createElement("p"));
            let span = p.appendChild(document.createElement("span"));
            p.appendChild(document.createElement("br"));
            const showLink = createShowLink(member, span);
            p.appendChild(showLink.a);
            links.push(showLink);
        }
    }
    return links;
}

function createShowLink(member, element) {
    //
    // create show-font link
    //
    let a = document.createElement("a");
    a.innerHTML = baseName(member.path);
    a.onclick = () => { loadFont(member, element, a); return false; };
    return {a, member, element};
}


///////////////////////////////////////////////////////////////////////////////
// user download

function downloadBytes(name, blob) {
    //
    // download binary content
    //
    // create another anchor and trigger download
    let a = document.createElement("a");
    a.className = "hidden download";
    a.download = baseName(name);
    a.href = window.URL.createObjectURL(blob);
    // trigger download
    a.click();
    a.remove();
}


///////////////////////////////////////////////////////////////////////////////
// Github interface

async function fontListFromGithub() {
    //
    // retrieve font list from Github
    //
    let tree = null;
    let refreshTime = JSON.parse(localStorage.getItem("refresh_time"));
    // hit github no more than once per hour (rate limit)
    if (refreshTime && Date.now() - refreshTime < 3.6e+6) {
        tree = JSON.parse(localStorage.getItem("github_tree"));
    }
    if (!tree) {
        console.log('refresh github tree');
        let url = "https://api.github.com/repos/robhagemans/hoard-of-bitfonts/git/trees/master?recursive=1";
        tree = await fetch(url)
            .then((response) => response.json())
            .then((result) => result.tree);
        localStorage.setItem("github_tree", JSON.stringify(tree));
        localStorage.setItem("refresh_time", JSON.stringify(Date.now()));
    }
    return tree;
}

async function downloadFromGithub(member) {
    //
    // user download of file from Github
    //
    let blob = await blobFromGithub(member);
    downloadBytes(member.path, blob);
    // do not follow link
    return false;
}

async function blobFromGithub(member) {
    //
    // get file from Github as blob
    //
    // use raw link instead of api link to avoid rate limit
    let url = 'https://raw.githubusercontent.com/robhagemans/hoard-of-bitfonts/master/' + member.path;
    let response = await fetch(url);
    let blob = await response.blob();
    return blob;
}

///////////////////////////////////////////////////////////////////////////////
// conversions


async function download(suffix, format, fontobj) {
    let path = fontobj.path;

    let basename = baseName(path);
    let stem = basename.split(".")[0];
    let localPath = "/" + basename;

    let outNames = [];
    for (let suffixElem of suffix.split(".").reverse()) {
        outNames.push(stem + '.' + suffixElem);
    }
    let outname = outNames.join("/")

    await ensureFile(fontobj, localPath);

    let py = await pyodide;
    py.globals.set("local_path", localPath);
    py.globals.set("outname", outname);
    py.globals.set("format", format);

    let pycode = `if 1:
        import monobit
        font, *_ = monobit.load(local_path)
        monobit.save(font, outname, format=format, overwrite=True)
    `
    await py.runPython(pycode);

    outname = outNames[0];
    let bytes = py.FS.readFile(outname);
    let blob = new Blob([bytes]);
    downloadBytes(outname, blob);
}



///////////////////////////////////////////////////////////////////////////
// drag & drop

// function createDownloadLink(member) {
//     //
//     // create download link to file
//     //
//     let a = document.createElement("a");
//     a.innerHTML = "&#9662;";
//     a.className = "hidden download";
//     a.onclick = () => { downloadFromGithub(member); return false; };
//     return a;
// }


//
// async function loadDroppedFont(file) {
//
//     let py = await pyodide;
//     let outname = file.name + '.yaff'
//     py.globals.set("path", file.name);
//     py.globals.set("outname", outname);
//     let arraybuffer = await file.arrayBuffer();
//     console.log(file.name);
//     py.FS.writeFile(file.name, new Uint8Array(arraybuffer));
//
//     let pycode = `if 1:
//         import monobit
//         font, *_ = monobit.load(path)
//         monobit.save(font, outname, overwrite=True)
//     `
//     await py.runPython(pycode);
//
//     let bytes = py.FS.readFile(outname);
//     let blob = new Blob([bytes]);
//
//     let listing = document.getElementById("listing0");
//     listing.value = await blob.text();
//     document.getElementById("filename").innerHTML = outname;
//     showFont();
// }



function setupHandlers() {
    //
    // handlers to load files on drag & drop
    //

    // function nop(e) {
    //     e.stopPropagation();
    //     e.preventDefault();
    // }
    //
    // function drop(e) {
    //     e.stopPropagation();
    //     e.preventDefault();
    //     let files = e.dataTransfer.files;
    //     loadDroppedFont(files[0]);
    // }
    //
    // var storage = document.getElementById("font-list");
    // storage.addEventListener("dragenter", nop);
    // storage.addEventListener("dragover", nop);
    // storage.addEventListener("drop", drop);
}
