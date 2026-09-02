/*
 * News agenda — Robbert&Frank Frank&Robbert
 *
 * Reads a public Google Calendar and renders it as two lists, past and
 * upcoming. One row per event: the date flush left as a pre-title, a red
 * disclosure arrow, the title, and the hours (or the closing date of a run)
 * on the right. An event with a description can be opened.
 *
 * Requires Luxon (assets/js/luxon.min.js).
 *
 *   new Agenda('calendar', apiKey, calendarId).setup()
 */

'use strict';

(function () {

  var DateTime = luxon.DateTime;

  var TEXT = {
    past: 'Past',
    upcoming: 'Upcoming',
    now: 'Now on',
    today: 'Today',
    loading: 'Loading…',
    noUpcoming: 'No upcoming events at the moment. Have a look at the past events, or subscribe to the newsletter.',
    noPast: 'No past events to show.',
    error: 'The agenda could not be loaded. Please try again later.'
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Is this node nothing but empty space? Used to trim the blank lines and
  // stray <br>s that Google Calendar descriptions tend to start and end with.
  function isBlank(node) {
    if (node.nodeType === 3) return !/\S/.test(node.nodeValue.replace(/\u00a0/g, ' '));
    if (node.nodeType !== 1) return true;
    if (node.nodeName === 'BR' || node.nodeName === 'HR') return true;
    if (node.querySelector('img, iframe, table')) return false;
    return !/\S/.test(node.textContent.replace(/\u00a0/g, ' '));
  }

  function trimEdges(box) {
    while (box.firstChild && isBlank(box.firstChild)) box.removeChild(box.firstChild);
    while (box.lastChild && isBlank(box.lastChild)) box.removeChild(box.lastChild);

    // A first paragraph that itself starts with blank lines: <p><br><br>text
    var first = box.firstElementChild;
    if (first) {
      while (first.firstChild && isBlank(first.firstChild)) first.removeChild(first.firstChild);
    }
  }

  // Descriptions are typed in Google Calendar, which stores whatever styling
  // was pasted in — including 36pt type and squeezed tracking. Sizes, leading,
  // faces and spacing are dropped so the description sits at the page's own
  // 16px europa; bold, italics, links and line breaks survive.
  //
  // Was this size meant as a heading? Anything more than a quarter bigger
  // than running text counts. Handles pt, px, em/rem, %, and the keywords.
  function isBigSize(value) {
    if (!value) return false;
    var size = String(value).toLowerCase().trim();
    if (/^(large|x-large|xx-large|xxx-large|larger)$/.test(size)) return true;

    var number = parseFloat(size);
    if (isNaN(number)) return false;
    if (size.indexOf('pt') !== -1) return number > 13;
    if (size.indexOf('px') !== -1) return number > 20;
    if (size.indexOf('%') !== -1) return number > 125;
    if (size.indexOf('em') !== -1) return number > 1.25;
    return false;
  }

  function sanitize(html) {
    var box = document.createElement('div');
    box.innerHTML = html;

    // Oversized type keeps its role as a heading, at a size the page decides.
    Array.prototype.forEach.call(box.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (el) {
      el.className += ' news-heading';
    });

    Array.prototype.forEach.call(box.querySelectorAll('font[size]'), function (el) {
      if (parseInt(el.getAttribute('size'), 10) >= 5) el.className += ' news-heading';
    });

    Array.prototype.forEach.call(box.querySelectorAll('[style]'), function (el) {
      if (isBigSize(el.style.fontSize)) el.className += ' news-heading';

      // everything that can squeeze, stretch or resize the type
      ['font-size', 'line-height', 'font-family', 'text-align', 'letter-spacing',
       'word-spacing', 'font-stretch', 'font-variant', 'transform', 'zoom',
       'text-indent', 'white-space'].forEach(function (property) {
        el.style.removeProperty(property);
      });
      if (!el.getAttribute('style')) el.removeAttribute('style');
    });

    Array.prototype.forEach.call(box.querySelectorAll('font[size], [width], [height], [align]'), function (el) {
      if (el.nodeName !== 'IMG') {
        el.removeAttribute('size');
        el.removeAttribute('width');
        el.removeAttribute('height');
      }
      el.removeAttribute('align');
    });

    trimEdges(box);
    return box.innerHTML;
  }

  // Google Calendar descriptions may already contain HTML. If they don't,
  // keep the line breaks and turn bare URLs into links.
  function formatDescription(text) {
    if (!text) return '';
    if (/<[a-z][\s\S]*>/i.test(text)) return sanitize(text);

    return escapeHtml(text.replace(/^[\s\u00a0]+/, ''))
      .replace(/(https?:\/\/[^\s<]+)/g, function (url) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
      })
      .split(/\n{2,}/)
      .map(function (block) { return '<p>' + block.replace(/\n/g, '<br>') + '</p>'; })
      .join('');
  }

  function Agenda(rootId, apiKey, calendarId) {
    this.root = document.getElementById(rootId);
    this.apiKey = apiKey;
    this.calendarId = calendarId;
    this.timeZone = 'Europe/Brussels';
    this.view = 'upcoming';
    this.cache = {};
  }

  Agenda.prototype.setup = function () {
    if (!this.root) return;

    this.root.innerHTML =
      '<div class="news-views">' +
        '<button type="button" data-view="past">' + TEXT.past + '</button>' +
        '<button type="button" data-view="upcoming">' + TEXT.upcoming + '</button>' +
      '</div>' +
      '<div class="news-list" aria-live="polite"></div>';

    this.list = this.root.querySelector('.news-list');
    this.root.addEventListener('click', this.onClick.bind(this));
    this.show('upcoming');
  };

  Agenda.prototype.onClick = function (event) {
    var view = event.target.closest('[data-view]');
    if (view) {
      this.show(view.getAttribute('data-view'));
      return;
    }

    var header = event.target.closest('.news-event-header');
    if (header) this.toggle(header);
  };

  // Same travelling speed whatever the length: a fixed duration makes a long
  // description look like it snaps open and a short one like it dawdles, so
  // the duration is derived from the distance and then clamped.
  // Not linear in the distance — that makes short ones twitchy and long ones
  // interminable — but square-rooted, so the apparent speed stays even:
  // 50px ≈ 0.30s, 200px ≈ 0.42s, 600px ≈ 0.59s, 1200px ≈ 0.76s.
  function slideDuration(height) {
    var seconds = 0.18 + Math.sqrt(Math.max(0, height)) / 60;
    return Math.min(0.8, Math.max(0.25, seconds)).toFixed(3) + 's';
  }

  // Slides open and shut. max-height is set in pixels for the transition and
  // released to "none" once it finishes, so a description that grows later
  // (an image loading, the window resizing) is never clipped.
  Agenda.prototype.toggle = function (header) {
    var item = header.closest('.news-event');
    var body = item.querySelector('.news-event-body');
    var inner = body && body.querySelector('.news-event-body-inner');
    var open = item.getAttribute('data-open') !== 'true';

    if (!body || !inner) {
      item.setAttribute('data-open', open ? 'true' : 'false');
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }

    var height = inner.offsetHeight;
    var duration = slideDuration(height);

    // The transition has to be in place BEFORE data-open flips, because that
    // flip is what changes visibility. Closing leaves a delay on visibility
    // (so the text does not vanish before the slide); if that delay were
    // still in force when the row is reopened, the text would stay invisible
    // until the slide finished.
    body.style.transition = open
      ? 'max-height ' + duration + ' ease, visibility 0s'
      : 'max-height ' + duration + ' ease, visibility 0s linear ' + duration;

    // Closing animates from a pixel value, not from "none", so give it one
    // and let the browser take it in before the value changes again.
    if (!open) {
      body.style.maxHeight = height + 'px';
      body.offsetHeight;
    }

    item.setAttribute('data-open', open ? 'true' : 'false');
    header.setAttribute('aria-expanded', open ? 'true' : 'false');

    if (open) {
      body.style.maxHeight = height + 'px';
      body.addEventListener('transitionend', function release(event) {
        if (event.propertyName !== 'max-height') return;
        body.removeEventListener('transitionend', release);
        // released, so a description that grows later — an image loading, the
        // window resizing — is never clipped
        if (item.getAttribute('data-open') === 'true') body.style.maxHeight = 'none';
      });
    } else {
      body.style.maxHeight = '0px';
    }
  };

  Agenda.prototype.show = function (view) {
    var self = this;
    this.view = view;

    Array.prototype.forEach.call(this.root.querySelectorAll('[data-view]'), function (button) {
      button.classList.toggle('is-current', button.getAttribute('data-view') === view);
    });

    if (this.cache[view]) {
      this.render(this.cache[view]);
      return;
    }

    this.list.innerHTML = '<div class="news-message">' + TEXT.loading + '</div>';

    this.fetchEvents(view).then(function (events) {
      self.cache[view] = events;
      if (self.view === view) self.render(events);
    }).catch(function (error) {
      console.error(error);
      self.list.innerHTML = '<div class="news-message">' + TEXT.error + '</div>';
    });
  };

  // ---------------------------------------------------------------- fetching

  Agenda.prototype.fetchEvents = function (view) {
    var self = this;
    var now = DateTime.local().setZone(this.timeZone);
    var params = {
      key: this.apiKey,
      orderBy: 'startTime',
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: '250',
      timeZone: this.timeZone
    };

    if (view === 'upcoming') {
      params.timeMin = now.toISO();
    } else {
      params.timeMax = now.toISO();
      params.timeMin = now.minus({ years: 6 }).startOf('year').toISO();
    }

    return this.fetchPages(params, []).then(function (items) {
      var events = items
        .map(function (item) { return self.normalise(item, now); })
        .filter(function (event) {
          return view === 'upcoming' ? event.end >= now : event.end < now;
        });

      // The API returns these in start order already; sorting again costs
      // nothing and keeps the list right if that ever changes.
      events.sort(function (a, b) { return a.start - b.start; });

      // Upcoming reads forwards, past reads backwards from today.
      return view === 'upcoming' ? events : events.reverse();
    });
  };

  Agenda.prototype.fetchPages = function (params, collected, pageToken) {
    var self = this;
    var query = Object.keys(params).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    });
    if (pageToken) query.push('pageToken=' + encodeURIComponent(pageToken));

    var url = 'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(this.calendarId) + '/events?' + query.join('&');

    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('Calendar request failed: ' + response.status);
      return response.json();
    }).then(function (data) {
      var items = collected.concat(data.items || []);
      if (data.nextPageToken && items.length < 1000) {
        return self.fetchPages(params, items, data.nextPageToken);
      }
      return items;
    });
  };

  Agenda.prototype.normalise = function (item, now) {
    var allDay = !!item.start.date;
    var start = DateTime.fromISO(item.start.dateTime || item.start.date, { zone: this.timeZone });
    var end = DateTime.fromISO(item.end.dateTime || item.end.date, { zone: this.timeZone });

    // For all-day events Google's end date is exclusive.
    var lastDay = allDay ? end.minus({ days: 1 }) : end;

    var description = item.description || '';

    var multiDay = lastDay.startOf('day') > start.startOf('day');
    var today = now.hasSame(start, 'day');

    return {
      title: item.summary || 'Untitled',
      description: description.trim(),
      location: item.location || '',
      allDay: allDay,
      start: start,
      end: end,
      lastDay: lastDay,
      multiDay: multiDay,
      // running right now, or starting today
      running: start <= now && end >= now && multiDay,
      today: today
    };
  };

  // --------------------------------------------------------------- rendering

  // pre-title: the start date, quietly
  // pre-title: weekday and date
  Agenda.prototype.dateLabel = function (event) {
    return event.start.toFormat('cccc d MMMM yyyy');
  };

  // to the right of the title: hours for a single day, the run's end otherwise
  Agenda.prototype.whenLabel = function (event) {
    if (event.multiDay) {
      var to = event.lastDay;
      return 'until ' + (to.year === event.start.year ? to.toFormat('d MMM') : to.toFormat('d MMM yyyy'));
    }

    if (event.allDay) return 'all day';

    var from = event.start.toFormat('HH:mm');
    var to2 = event.end.toFormat('HH:mm');
    return from === to2 ? from : from + ' – ' + to2;
  };

  Agenda.prototype.tagFor = function (event) {
    if (event.running) return TEXT.now;
    if (event.today) return TEXT.today;
    return '';
  };

  Agenda.prototype.render = function (events) {
    if (!events.length) {
      this.list.innerHTML = '<div class="news-message">' +
        (this.view === 'upcoming' ? TEXT.noUpcoming : TEXT.noPast) + '</div>';
      return;
    }

    var self = this;
    var id = 0;

    this.list.innerHTML = '<ul class="news-events">' + events.map(function (event) {
      return self.eventHtml(event, 'news-event-' + (++id));
    }).join('') + '</ul>';
  };

  Agenda.prototype.eventHtml = function (event, id) {
    var title = escapeHtml(event.title);
    var body = formatDescription(event.description);

    if (event.location) {
      body += '<p><strong>Where</strong> ' + escapeHtml(event.location) + '</p>';
    }

    var tag = this.view === 'upcoming' ? this.tagFor(event) : '';
    var meta = '<span class="news-event-meta">' +
      '<span class="news-event-date">' + escapeHtml(this.dateLabel(event)) + '</span>' +
      (tag ? '<span class="news-tag">' + tag + '</span>' : '') +
      '</span>';

    var when = '<span class="news-event-when">' + escapeHtml(this.whenLabel(event)) + '</span>';

    // Nothing to open: a plain row, with no marker promising more.
    if (!body) {
      return '<li class="news-event">' +
        '<div class="news-event-static">' +
          meta +
          '<span class="news-event-title">' + title + '</span>' +
          when +
        '</div>' +
      '</li>';
    }

    return '<li class="news-event" data-open="false">' +
      '<button type="button" class="news-event-header" aria-expanded="false" aria-controls="' + id + '">' +
        meta +
        '<span class="news-marker" aria-hidden="true"></span>' +
        '<span class="news-event-title">' + title + '</span>' +
        when +
      '</button>' +
      '<div class="news-event-body" id="' + id + '">' +
        '<div class="news-event-body-inner">' + body + '</div>' +
      '</div>' +
    '</li>';
  };

  window.Agenda = Agenda;

})();
