$(function() {
    expandtobreak();
    closetobreak();
    expandjourney();
    closejourney();
    smoothScroll(800);
});

function expandjourney(){
  
  $(document).ready(function() {
  $('#journeytrigger').click(function(){
    $('#journeytrigger').toggleClass("expander-hidden");
  });
});
    
}


function closejourney(){
    
    $(document).ready(function() {
  $('#journeyclose').click(function(){
    $('#journeytrigger').toggleClass("expander-hidden");
  });
});
    
}

function expandtobreak(){
  
  $(document).ready(function() {
  $('#tobreaktrigger').click(function(){
    $('#tobreaktrigger').toggleClass("expander-hidden");
  });
});
    
}


function closetobreak(){
    
    $(document).ready(function() {
  $('#tobreakclose').click(function(){
    $('#tobreaktrigger').toggleClass("expander-hidden");
  });
});
    
}


function smoothScroll (duration) {
	$('a[href^="#"]').on('click', function(event) {

	    var target = $( $(this).attr('href') );

	    if( target.length ) {
	        event.preventDefault();
	        $('html, body').animate({
	            scrollTop: target.offset().top
	        }, duration);
	    }
	});
}