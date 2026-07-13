import * as browser from 'webextension-polyfill';
import $ from 'jquery';
import 'bootstrap';
import ClipboardJS from 'clipboard';

import { getCurrentTabHostname } from '../background_scripts/utils';

let state;
let builtCsp;

const applyModel = model => {
  state = model.state;
  builtCsp = model.builtCsp;
};


const getCustomCsp = host => {
  return {
    exists: state.config.customcspHosts.includes(host),
    text: state.config.customcspRecords[host],
  };
};


const insertCspConfig = () => {
  const strictness = state.config.strictness;

  // for each strictness level, we need to add a select for it
  Object.entries(strictness).forEach((kv) => {
    const directive = kv[0];
    const setting = kv[1];

    // set the proper value on the select
    document.getElementById(`csp-config-${directive}`).value = setting;
  });
};


const writeStrictnessToState = () => {
  const strictness = state.config.strictness;

  // read in all the CSP config settings
  for (const row of document.getElementsByClassName('csp-form-control')) {
    strictness[row.getAttribute('data-directive')] = row.value;
  }
};


const insertCsp = host => {
  const builtCSP = builtCsp;

  $('#csp-record').text(builtCSP.text);

  // enable tooltips, if they are a reasonable length
  if (builtCSP.text.length < 768) {
    $('#csp-col').attr('data-original-title', builtCSP.html).tooltip();
  } else {
    $('#csp-col').attr('data-original-title', 'CSP policy is too long to display in this tooltip, sorry!<br><br>But hey, thanks for being <strong>awesome</strong> and trying out Laboratory!').tooltip();
  }

  // TODO: make sure things are clear if you're using unsafe-inline
  if ('script-src' in builtCSP.records) {
    if (builtCSP.records['script-src'].includes('\'unsafe-inline\'') ||
        builtCSP.records['script-src'].includes('\'unsafe-eval\'') ||
        builtCSP.records['script-src'].includes('data:')) {
      // make the column look scary
      $('#csp-col').addClass('alert-danger');
      $('#csp-row-unsafe-inline-warning').removeClass('hidden');
    } else {
      $('#csp-col').removeClass('alert-danger');
      $('#csp-row-unsafe-inline-warning').addClass('hidden');
    }
  }

  return builtCSP.records;
};


const insertRecordingCount = () => {
  // insert the proper count of how many sites are being recorded
  document.getElementById('csp-recording-count').textContent = state.config.recordingHosts.length.toString();
};


// TODO: rename
const toggleToggler = (host) => {
  const states = {
    customcsp: getCustomCsp(host).exists,
    enforced: state.config.enforcedHosts.includes(host),
    recording: state.config.recordingHosts.includes(host),
  };

  // set all the toggler states
  Object.entries(states).forEach(([toggleId, toggled]) => {
    $(`#csp-toggle-${toggleId}`).prop('checked', toggled);
  });

  // hide/show the Edit and/or Copy items, depending on whether or not we have a custom CSP
  $('.csp-edit-item').toggleClass('hidden', !states.customcsp);
  $('.csp-copy-item').toggleClass('hidden', states.customcsp);
  $('#csp-record').parent().toggleClass('success', states.customcsp);

  // start with a clean slate
  $('.csp-toggle').prop('disabled', false);
  $('.csp-toggle-label').removeClass('disabled');

  // if we've got a custom CSP, we check the enforced button and disable everything else
  if (states.customcsp) {
    $('#csp-toggle-recording').prop('checked', false).prop('disabled', true);
    $('#csp-toggle-enforced').prop('checked', true).prop('disabled', true);
    $('#csp-toggle-recording-label, #csp-toggle-enforced-label').addClass('disabled');
  } else if (states.enforced) {
    // enable or disable recording, if enforcement is checked
    $('#csp-toggle-recording').prop('disabled', states.enforced);
    $('#csp-toggle-recording-label').addClass('disabled');
  }

  // if the host is undefined (such as on a blank tab, disable all toggles)
  if (host === '') {
    $('.csp-toggle').prop('disabled', true);
  }
};


const toggleEvent = async (e) => {
  const host = await getCurrentTabHostname();

  // get the toggle name
  const toggleId = e.target.id.split('-').pop();

  const model = await browser.runtime.sendMessage({
    type: 'laboratory:toggle',
    host,
    toggleId,
    enabled: e.target.checked,
  });
  applyModel(model);

  // update the number of sites we're recording
  insertRecordingCount();

  // if we're triggering the custom CSP, pop up the modal if needed
  if (toggleId === 'customcsp' && e.target.checked) {
    $('#csp-customcsp-modal').modal();
  }

  // set the toggle dependencies
  toggleToggler(host);

  insertCsp(host);
};


const handleDOMContentLoaded = async (reload = false) => {
  const host = await getCurrentTabHostname();
  const model = await browser.runtime.sendMessage({ type: 'laboratory:get-model', host });
  applyModel(model);

  // set the correct number of recorded hosts
  insertRecordingCount();

  if (!reload) {  // we only want to do this when not recursing
    /* BEGIN MODAL CODE */

    // the custom CSP edit button
    $('#csp-btn-edit').on('click', () => { $('#csp-customcsp-modal').modal(); });

    // automatically focus on input in modal and set the input value
    $('#csp-customcsp-modal').on('shown.bs.modal', () => {
      const v = state.config.customcspRecords[host] || 'default-src \'none\'';
      $('#csp-customcsp-record').val(v).select();
    });

    // save the value of the custom CSP when we close the modal and refresh
    // the dom content
    const save = async () => {
      const v = $('#csp-customcsp-record').val().trim();
      const updated = await browser.runtime.sendMessage({
        type: 'laboratory:update-custom-csp',
        host,
        text: v,
      });
      applyModel(updated);
      await handleDOMContentLoaded(true);
    };

    $('#csp-customcsp-save').on('click', save);
    $('#csp-customcsp-modal').on('keyup', e => {
      if (e.keyCode === 13) {
        save();
        $('#csp-customcsp-modal').modal('hide');
      }
    });

    $('#csp-customcsp-clear').on('click', () => {
      $('#csp-customcsp-record').val('').select();
    });

    /* END MODAL CODE */

    // set events on all the togglers
    $('.csp-toggle').on('click', toggleEvent);

    // bind a listener for the trash icon to delete all records
    $('#btn-trash').on('click', async () => {
      const updated = await browser.runtime.sendMessage({ type: 'laboratory:clear-state', host });
      applyModel(updated);
      await handleDOMContentLoaded(true);
    });

    // bind a listener for every time we change a config setting
    // TODO: make this more generic
    $('#csp-config').on('change', async () => {
      writeStrictnessToState();
      const updated = await browser.runtime.sendMessage({
        type: 'laboratory:update-strictness',
        host,
        strictness: state.config.strictness,
      });
      applyModel(updated);
      insertCsp(host);
    });
  }

  // retrieve a site's active status and check the box if its active
  toggleToggler(host);

  // display the current CSP if we have one
  const records = insertCsp(host);

  // insert the config pulldowns
  insertCspConfig();

  // unhide configuration directions for CSP records that are actually there
  let numRecords = 0;
  Object.entries(records).forEach(([k, v]) => {
    if (v.length > 0) {
      $(`#csp-config-row-${k}`).removeClass('hidden');
      numRecords += v.length;
    }
  });

  // if we actually have no records yet, hide the entire configuration section
  if (numRecords === 0) {
    $('#csp-config').addClass('hidden');
  }

  // initialize all our clipboards
  new ClipboardJS('.btn');

  // initialize the copied button popover, and have it disappear after one second
  $('#csp-btn-copy').popover({
    html: true,
  }).click(() => {
    setTimeout(() => {
      $('#csp-btn-copy').popover('hide');
    }, 1000)
  });
};


// initialize the document
document.addEventListener('DOMContentLoaded', async () => {
  handleDOMContentLoaded();
});
